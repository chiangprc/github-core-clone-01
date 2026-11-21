// objects.ts — the git object model on node:crypto + node:zlib only.
// Everything here is written fresh from the git object/packfile format as the conformance
// suite's client exercises it; no git binary, no vendored library.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { trialNow } from './store.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_CODE: Readonly<Record<string, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export const ZERO_OID = '0'.repeat(40);

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 over `<type> <size>\0` + body: exactly how git computes an object id. */
export function sha1Object(type: string, body: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

/** Decode a loose object (zlib bytes): split `<type> <size>\0` from the body. */
export function parseObject(raw: Buffer): { type: string; body: Buffer } {
  const inflated = inflateSync(raw);
  const nul = inflated.indexOf(0);
  if (nul < 0) throw new Error('loose object has no header terminator');
  const header = inflated.subarray(0, nul).toString('utf8');
  const space = header.indexOf(' ');
  if (space < 0) throw new Error(`loose object header ${JSON.stringify(header)} has no size`);
  const type = header.slice(0, space);
  const size = Number(header.slice(space + 1));
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`loose object header has a bad size ${JSON.stringify(header)}`);
  const body = inflated.subarray(nul + 1);
  if (body.length !== size) throw new Error(`loose object declares ${size} bytes but holds ${body.length}`);
  return { type, body: Buffer.from(body) };
}

/** Encode a loose object: zlib-deflate of `<type> <size>\0` + body. */
export function encodeObject(type: string, body: Buffer): Buffer {
  return deflateSync(Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'utf8'), body]));
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a commit object into its headers and message. */
export function parseCommit(body: Buffer): CommitView {
  const blank = body.indexOf('\n\n');
  const headerEnd = blank < 0 ? body.length : blank;
  const message = blank < 0 ? '' : body.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let lastKey = '';
  let lastValue = '';
  const flush = (): void => {
    if (lastKey === 'tree') tree = lastValue;
    else if (lastKey === 'parent') parents.push(lastValue);
    else if (lastKey === 'author') author = lastValue;
    else if (lastKey === 'committer') committer = lastValue;
  };
  for (const line of body.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line.startsWith(' ') && lastKey !== '') {
      lastValue += `\n${line}`;
      continue;
    }
    flush();
    const space = line.indexOf(' ');
    lastKey = space < 0 ? line : line.slice(0, space);
    lastValue = space < 0 ? '' : line.slice(space + 1);
  }
  flush();
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) if (!isOid(parent)) throw new Error('commit has a bad parent id');
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object. */
export function parseTag(body: Buffer): TagView {
  const blank = body.indexOf('\n\n');
  const headerEnd = blank < 0 ? body.length : blank;
  const headers = new Map<string, string>();
  for (const line of body.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : body.subarray(blank + 2).toString('utf8'),
  };
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = body.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > body.length) throw new Error('tree entry has a truncated object id');
    const mode = body.subarray(offset, space).toString('ascii');
    const name = body.subarray(space + 1, nul).toString('utf8');
    const sha = body.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isOid(entry.sha)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** trialNow() as Unix seconds, parsed deterministically (no clock read). */
function trialEpochSec(): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(trialNow());
  if (match === null) return 1794606600;
  const [, y, mo, d, h, mi, s] = match;
  return Math.floor(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000);
}

/**
 * Build a commit object's bytes. `author` is `Name <email>`; a trailing ` <epoch> <tz>` is
 * honoured verbatim, otherwise the trial's fixed timestamp (+0000) is appended. The committer
 * is the author. The message is used verbatim.
 */
export function buildCommit(tree: string, parents: readonly string[], message: string, author: string): Buffer {
  if (!isOid(tree)) throw new Error('buildCommit needs a valid tree id');
  const ident = / \d+ [+-]\d{4}$/.test(author) ? author : `${author} ${trialEpochSec()} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) {
    if (!isOid(parent)) throw new Error('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${ident}`, `committer ${ident}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pktLine(s: string | Buffer): Buffer {
  const data = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  if (data.length > 65516) throw new Error(`pkt-line payload is ${data.length} bytes, over the 65516-byte maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet, `0000`. */
export function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet, `0001`. */
export function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

// ---------------------------------------------------------------------------------------------
// delta application (git's copy/insert instruction stream)
// ---------------------------------------------------------------------------------------------

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------------------------

export interface ObjectStore {
  objects: Map<string, { type: string; data: Buffer }>;
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/**
 * Parse a packfile (version 2/3), resolving OFS_DELTA and REF_DELTA (a thin pack's bases may
 * come from the store), and store every object into the store's objects map. Throws on any
 * corruption: a bad pack is never half-applied.
 */
export function parsePack(buf: Buffer, store: ObjectStore): void {
  const buffer = buf;
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error(`pack trailer ${trailer} does not match its bytes ${computedTrailer}`);

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const resolvedByOid = new Map<string, { type: string; data: Buffer }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: string; data: Buffer; oid: string } => {
    const cached = (entry as RawEntry & { resolved?: { type: string; data: Buffer; oid: string } }).resolved;
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: string;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const inPack = resolvedByOid.get(wanted);
      if (inPack !== undefined) {
        type = inPack.type;
        data = applyDelta(inPack.data, entry.data);
      } else {
        const external = store.objects.get(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = sha1Object(type, data);
    const result = { type, data, oid };
    (entry as RawEntry & { resolved?: { type: string; data: Buffer; oid: string } }).resolved = result;
    resolvedByOid.set(oid, { type, data });
    resolving.delete(entry.offset);
    return result;
  };

  // Resolve everything into a scratch map first: a corrupt pack stores nothing.
  const fresh = new Map<string, { type: string; data: Buffer }>();
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!fresh.has(resolved.oid)) fresh.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  for (const [oid, object] of fresh) store.objects.set(oid, object);
}

/** Encode one object's pack header: the type/size varint the pack format uses. */
function writePackObjectHeader(type: string, size: number): Buffer {
  const code = TYPE_CODE[type];
  if (code === undefined) throw new Error(`pack cannot hold object type ${JSON.stringify(type)}`);
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Entries are emitted in the given order. */
export function encodePack(objects: ReadonlyArray<{ type: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Every object reachable from `roots`: commit → tree + parents, tag → target, tree → entries. */
export function collectReachable(store: ObjectStore, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.sha);
      }
    }
  }
  return seen;
}

/**
 * Emit a pack containing the wanted objects and their reachable closure. Full objects only,
 * no deltas. Oids are sorted, so the same closure always packs to the same bytes.
 */
export function buildPack(store: ObjectStore, wants: string[]): Buffer {
  const closure = collectReachable(store, wants);
  const objects: Array<{ type: string; data: Buffer }> = [];
  for (const oid of [...closure].sort()) {
    const object = store.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return encodePack(objects);
}
