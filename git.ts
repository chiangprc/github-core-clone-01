// git.ts — git smart HTTP (protocol v2 + v0) over the shared store.
//
// The conformance suite's git-client.ts is the spec this implements: v2 advertisement and
// ls-refs/fetch, v0 ref advertisement for receive-pack, sideband packfiles, shallow deepen,
// per-ref report-status, and a 404 for a missing repository (a push never invents a repo;
// repositories are created through the REST surface).
//
// No git binary, no network, no clock: every byte served is derived from the store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { collectReachable, delimPkt, encodePack, flushPkt, parseCommit, parsePack, parseTag, parseTree, pktLine, ZERO_OID } from './objects.ts';
import { Store, type Repo } from './store.ts';

const AGENT = 'makefun-forge/1.0';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** v0 upload-pack capabilities (first ref line, after the NUL). */
const V0_UPLOAD_CAPS =
  'agent=makefun-forge/1.0 side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main object-format=sha1';
/** v0 receive-pack capabilities: report-status, side-band-64k and delete-refs are required. */
const V0_RECEIVE_CAPS = 'agent=makefun-forge/1.0 report-status side-band-64k delete-refs ofs-delta';

export interface GitOptions {
  /** When set, git requests must carry `Authorization: Bearer <token>`; otherwise unauthenticated. */
  token?: string;
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------
// pkt-line decoding (a whole buffered body)
// ---------------------------------------------------------------------------------------------

type Packet =
  | { kind: 'flush'; payload: Buffer }
  | { kind: 'delim'; payload: Buffer }
  | { kind: 'response-end'; payload: Buffer }
  | { kind: 'data'; payload: Buffer };

function readPacket(buf: Buffer, offset: number): { packet: Packet; next: number } {
  if (offset + 4 > buf.length) throw new Error(`truncated pkt-line at offset ${offset}`);
  const header = buf.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(header)) {
    throw new Error(`invalid pkt-line length ${JSON.stringify(header)} at offset ${offset}`);
  }
  const length = Number.parseInt(header, 16);
  if (length === 0) return { packet: { kind: 'flush', payload: Buffer.alloc(0) }, next: offset + 4 };
  if (length === 1) return { packet: { kind: 'delim', payload: Buffer.alloc(0) }, next: offset + 4 };
  if (length === 2) return { packet: { kind: 'response-end', payload: Buffer.alloc(0) }, next: offset + 4 };
  if (length === 3) throw new Error('invalid pkt-line length 0003');
  if (length > 65520) throw new Error(`pkt-line length ${length} exceeds 65520`);
  if (offset + length > buf.length) {
    throw new Error(`truncated pkt-line: ${length} announced, ${buf.length - offset} available`);
  }
  return { packet: { kind: 'data', payload: buf.subarray(offset + 4, offset + length) }, next: offset + length };
}

function decodePackets(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const { packet, next } = readPacket(buf, offset);
    packets.push(packet);
    offset = next;
  }
  return packets;
}

function firstPacketText(body: Buffer): string | null {
  if (body.length < 4) return null;
  const { packet } = readPacket(body, 0);
  if (packet.kind !== 'data') return null;
  return packet.payload.toString('utf8');
}

// ---------------------------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.default_branch}`;
}

/** Peel a tag object to the commit it names (following tag chains); null when it is not a tag. */
function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return null;
    const target = parseTag(obj.data).object;
    const targetObj = repo.objects.get(target);
    if (targetObj !== undefined && targetObj.type === 'commit') return target;
    if (targetObj !== undefined && targetObj.type === 'tag') {
      current = target;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done unborn\n'),
    pktLine('object-format=sha1\n'),
    flushPkt(),
  ]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), flushPkt()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headTarget(repo));
    parts.push(pktLine(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// v2 requests
// ---------------------------------------------------------------------------------------------

/** Split a v2 request body into its pre-delim lines and its argument lines. */
function parseV2Request(body: Buffer, expectedCommand: string): { args: string[] } {
  const packets = decodePackets(body);
  const pre: string[] = [];
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (seenDelim) args.push(text.replace(/\n$/, ''));
    else pre.push(text);
  }
  const commandLine = (pre[0] ?? '').replace(/\n$/, '');
  if (commandLine !== `command=${expectedCommand}`) {
    throw new Error(`expected command=${expectedCommand}, got ${JSON.stringify(commandLine)}`);
  }
  return { args };
}

function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { args } = parseV2Request(body, 'ls-refs');
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

/** A tree and everything under it, added to `set` (blobs included). */
function addTreeClosure(repo: Repo, set: Set<string>, treeOid: string): void {
  const stack = [treeOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (set.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    set.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.sha);
      }
    }
  }
}

/**
 * What the client already holds: the closure of its haves, except that below one of its
 * shallow boundaries it holds the boundary commit and its tree, but not the parents. A have
 * the store does not know contributes nothing.
 */
function heldClosure(repo: Repo, haves: readonly string[], shallowBoundaries: readonly string[]): Set<string> {
  const held = new Set<string>();
  const shallowSet = new Set(shallowBoundaries);
  const queue = [...haves];
  while (queue.length) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      addTreeClosure(repo, held, commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      addTreeClosure(repo, held, oid);
    }
  }
  return held;
}

interface FetchPlan {
  objects: Array<{ type: string; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * The fetch: which objects to send for `wants`, given the client's haves, its shallow
 * boundaries and an optional `deepen` depth. Depth counts generations from the wants
 * (depth 1 is the wanted commits only); a commit at the limit whose parents are not held
 * is a new shallow boundary. Nothing the client holds is re-sent.
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const held = heldClosure(repo, haves, oldShallow);
  const wantClosure = collectReachable(repo, wants);
  const acks: string[] = [];
  for (const have of haves) if (wantClosure.has(have)) acks.push(have);

  const included = new Set<string>();
  const levelOf = new Map<string, number>();
  const queue: Array<{ oid: string; level: number }> = [];
  const pushCommit = (oid: string, level: number): void => {
    const prev = levelOf.get(oid);
    if (prev !== undefined && prev <= level) return;
    levelOf.set(oid, level);
    queue.push({ oid, level });
  };
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (!held.has(want)) included.add(want);
      const target = parseTag(obj.data).object;
      const targetObj = repo.objects.get(target);
      if (targetObj !== undefined && targetObj.type === 'commit') pushCommit(target, 1);
      else if (targetObj !== undefined && !held.has(target)) included.add(target);
    } else if (obj.type === 'commit') {
      pushCommit(want, 1);
    } else if (!held.has(want)) {
      included.add(want);
    }
  }
  const processedAt = new Map<string, number>();
  while (queue.length) {
    const { oid, level } = queue.pop()!;
    const best = levelOf.get(oid);
    if (best === undefined || best !== level) continue;
    if (processedAt.get(oid) === level) continue;
    if (depth !== undefined && level > depth) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    processedAt.set(oid, level);
    if (!held.has(oid)) included.add(oid);
    const commit = parseCommit(obj.data);
    if (depth !== undefined && level >= depth) continue;
    for (const parent of commit.parents) pushCommit(parent, level + 1);
  }
  // Trees and blobs under the included commits (and directly included trees).
  const treeStack: string[] = [];
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') treeStack.push(parseCommit(obj.data).tree);
    else if (obj.type === 'tree') treeStack.push(oid);
  }
  const seenTree = new Set<string>();
  while (treeStack.length) {
    const oid = treeStack.pop()!;
    if (seenTree.has(oid) || held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') continue;
    seenTree.add(oid);
    included.add(oid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '160000') continue;
      const child = repo.objects.get(entry.sha);
      if (child === undefined) continue;
      if (child.type === 'tree') treeStack.push(entry.sha);
      else if (!held.has(entry.sha)) included.add(entry.sha);
    }
  }
  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const oid of included) {
      if (levelOf.get(oid) !== depth) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((parent) => !included.has(parent) && !held.has(parent))) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const boundary of oldShallow) {
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((parent) => included.has(parent) || held.has(parent))) unshallow.push(boundary);
  }
  const objects: Array<{ type: string; data: Buffer }> = [];
  for (const oid of [...included].sort()) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.push(obj);
  }
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort(), acks: acks.sort() };
}

/** A pack split into sideband band-1 pkt-lines (each at most 65520 bytes framed). */
function sidebandChunks(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX_DATA = 65515;
  for (let offset = 0; offset < pack.length; offset += MAX_DATA) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + MAX_DATA));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function fetchResponseV2(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(delimPkt());
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(delimPkt());
  }
  if (plan.objects.length) {
    parts.push(pktLine('packfile\n'));
    for (const chunk of sidebandChunks(encodePack(plan.objects))) parts.push(chunk);
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function fetchResponseV0(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const chunk of sidebandChunks(encodePack(plan.objects))) parts.push(chunk);
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: accepted, ignored.
  }
  return { wants, haves, shallow, depth };
}

function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const { args } = parseV2Request(body, 'fetch');
  const parsed = parseFetchArgs(args);
  return fetchResponseV2(planFetch(repo, parsed.wants, parsed.haves, parsed.shallow, parsed.depth));
}

function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const packets = decodePackets(body);
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // The first want line may carry capabilities after the oid.
      const oid = line.slice(5).split(' ')[0];
      if (oid !== undefined && oid !== '') args.push(`want ${oid}`);
    } else {
      args.push(line);
    }
  }
  const parsed = parseFetchArgs(args);
  return fetchResponseV0(planFetch(repo, parsed.wants, parsed.haves, parsed.shallow, parsed.depth));
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** True when `oldOid` is an ancestor of (or equal to) `newOid`, peeling tags to their commit. */
function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  let tip = newOid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = repo.objects.get(tip);
    if (obj === undefined) return false;
    if (obj.type === 'tag') {
      tip = parseTag(obj.data).object;
      continue;
    }
    if (obj.type !== 'commit') return false;
    break;
  }
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

function applyRefUpdate(repo: Repo, cmd: PushCommand): { ok: boolean; reason: string } {
  const current = repo.refs.get(cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'non-fast-forward' };
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(cmd.ref);
    return { ok: true, reason: '' };
  }
  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    if (repo.objects.get(cmd.newOid) === undefined) return { ok: false, reason: 'missing object' };
    repo.refs.set(cmd.ref, cmd.newOid);
    return { ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return { ok: false, reason: 'non-fast-forward' };
  if (cmd.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (cmd.newOid === cmd.oldOid) return { ok: true, reason: '' };
  if (repo.objects.get(cmd.newOid) === undefined) return { ok: false, reason: 'missing object' };
  if (cmd.ref.startsWith('refs/heads/') && !isFastForward(repo, cmd.oldOid, cmd.newOid)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(cmd.ref, cmd.newOid);
  return { ok: true, reason: '' };
}

async function handleReceivePack(repo: Repo, body: Buffer): Promise<Buffer> {
  let offset = 0;
  const commandLines: string[] = [];
  let sawFlush = false;
  while (offset < body.length) {
    const { packet, next } = readPacket(body, offset);
    offset = next;
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    commandLines.push(packet.payload.toString('utf8'));
  }
  if (!sawFlush || commandLines.length === 0) throw new Error('receive-pack sent no commands');
  const packBytes = body.subarray(offset);

  const commands: PushCommand[] = [];
  let capabilities = '';
  for (let i = 0; i < commandLines.length; i += 1) {
    let line = commandLines[i]!.replace(/\n$/, '');
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) {
      throw new Error('receive-pack command has a bad object id');
    }
    commands.push({ oldOid, newOid, ref });
  }
  const sideband = capabilities.split(' ').includes('side-band-64k');

  // Unpack first: a corrupt pack stores nothing and refuses every ref.
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      parsePack(packBytes, repo);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const verdict = applyRefUpdate(repo, cmd);
      reportLines.push(verdict.ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${verdict.reason}\n`);
    }
  }
  const parts: Buffer[] = [];
  for (const line of reportLines) {
    const payload = sideband
      ? Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')])
      : Buffer.from(line, 'utf8');
    parts.push(pktLine(payload));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/**
 * Serve one git smart-HTTP request. `subpath` is the path after `/<owner>/<repo>.git`
 * (e.g. `/info/refs`, `/git-upload-pack`, `/git-receive-pack`). Returns true when the
 * request is a git route (handled, even when the answer is a 404 or 400); false when it
 * is not a git route at all and the caller should answer it another way.
 */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repo: string,
  subpath: string,
  opts: GitOptions = {},
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const isInfoRefs = subpath === '/info/refs' && method === 'GET';
  const isUploadPack = subpath === '/git-upload-pack' && method === 'POST';
  const isReceivePack = subpath === '/git-receive-pack' && method === 'POST';
  if (!isInfoRefs && !isUploadPack && !isReceivePack) return false;
  try {
    if (opts.token !== undefined) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${opts.token}`) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return true;
      }
    }
    const repoObj = store.getRepo(owner, repo);
    if (repoObj === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (isInfoRefs) {
      let service: string | null = null;
      try {
        service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service');
      } catch {
        service = null;
      }
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Not Found' });
        return true;
      }
      const v2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
      const body = v2 ? v2Advertisement() : v0Advertisement(repoObj, service);
      sendBuffer(res, 200, `application/x-${service}-advertisement`, body);
      return true;
    }
    const body = await readBody(req);
    if (isUploadPack) {
      const first = firstPacketText(body);
      let out: Buffer;
      if (first !== null && first.startsWith('command=')) {
        const command = first.replace(/\n$/, '').slice('command='.length);
        if (command === 'ls-refs') out = handleLsRefs(repoObj, body);
        else if (command === 'fetch') out = handleFetchV2(repoObj, body);
        else throw new Error(`unsupported v2 command ${JSON.stringify(command)}`);
      } else {
        out = handleFetchV0(repoObj, body);
      }
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', out);
      return true;
    }
    const out = await handleReceivePack(repoObj, body);
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', out);
    return true;
  } catch (err) {
    if (!res.headersSent) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { message });
    } else {
      try {
        res.end();
      } catch {
        // The response is already closing; nothing more to do.
      }
    }
    return true;
  }
}
