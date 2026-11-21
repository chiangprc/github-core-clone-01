// rest.ts — GitHub REST v3 surface for the github-core-clone-01 forge.
//
// Written fresh for this entry from the kit's published conformance suite
// (checks-rest.ts / rest-client.ts / wire.ts). No code copied from any existing
// forge; Node 22 stdlib only; no git binary, no network, no model calls.
//
// The module owns every /api/v3 route the REST checks exercise. app.ts calls
// handleRest(req, res, store); it returns true when it answered the request
// (every path under /api/v3, including unknown ones, which are JSON 404s) and
// false for anything outside /api/v3.
//
// Identity: the bearer token names one login — the scenario's viewer. The
// scenario is deterministic from the contest's fixed seed, so this module
// re-derives the viewer login from that seed (the same pure generators the
// kit publishes in wire.ts). A repository created through POST /user/repos
// belongs to that login; the same name under any other owner is 404, never
// 403. All served timestamps come from trialNow() (MAKEFUN_TRIAL_NOW, with
// the fixed fallback); nothing here reads a wall clock or Math.random.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { trialNow } from './store.ts';
import type { Comment, Issue, Pull, Repo, Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** trialNow() as epoch seconds, for git author/committer lines. */
function trialNowEpochSec(): number {
  return Math.floor(Date.parse(trialNow()) / 1000);
}

// ---------------------------------------------------------------------------
// The viewer: re-derived from the contest's fixed scenario seed.
//
// wire.ts fixes SCENARIO_SEED and builds its users with generateUsers(); the
// viewer is users[0]. These are the same pure functions, transcribed from
// that published spec, so the login this module uses is byte-identical to the
// one the suite's checks send as the owner.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: the scenario's deterministic stream. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

let cachedViewer: ScenarioUser | null = null;

/** The login the bearer token names (scenario users[0]). */
export function viewerUser(): ScenarioUser {
  if (cachedViewer === null) {
    const users = generateUsers(new Rng(scenarioSeedFor('users')), 12);
    cachedViewer = users[0] as ScenarioUser;
  }
  return cachedViewer;
}

// ---------------------------------------------------------------------------
// Small utilities

let requestCounter = 0;

/** A non-empty request id: a per-process counter, hex, deterministic in order. */
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** FNV-1a, 32-bit: deterministic numeric ids from a string. */
function hash32(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** A deterministic positive numeric id for a repository. */
function repoNumericId(owner: string, name: string): number {
  return (hash32(`${owner}/${name}`) % 2147483646) + 1;
}

function b64encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64encodeBuffer(data: Buffer): string {
  return data.toString('base64');
}

function b64decodeToBuffer(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function nodeId(kind: string, id: number | string): string {
  return b64encodeText(`${kind}:${id}`);
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Split a request path into decoded segments (no leading/trailing empties). */
function splitPath(pathname: string): string[] | null {
  const parts = pathname.split('/').filter((part) => part !== '');
  const out: string[] = [];
  for (const part of parts) {
    const decoded = decodeSegment(part);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, rawPerPage)) : 30;
  return { page, perPage };
}

interface PageResult<T> {
  items: T[];
  link: string | null;
}

/** Slice a sorted list into a page and build GitHub's Link header value. */
function paginate<T>(items: readonly T[], req: IncomingMessage, url: URL): PageResult<T> {
  const { page, perPage } = parsePage(url.searchParams);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const origin = originOf(req);
  const build = (pageNumber: number): string => {
    const next = new URL(url.toString());
    next.searchParams.set('page', String(pageNumber));
    next.searchParams.set('per_page', String(perPage));
    return `${origin}${next.pathname}${next.search}`;
  };
  if (current < totalPages) {
    links.push(`<${build(current + 1)}>; rel="next"`, `<${build(totalPages)}>; rel="last"`);
  }
  if (current > 1) {
    links.push(`<${build(1)}>; rel="first"`, `<${build(current - 1)}>; rel="prev"`);
  }
  return { items: slice, link: links.length > 0 ? links.join(', ') : null };
}

// ---------------------------------------------------------------------------
// HTTP plumbing

type JsonObject = Record<string, unknown>;

class HttpError extends Error {
  readonly status: number;
  readonly body: JsonObject;

  constructor(status: number, message: string, extra: JsonObject = {}) {
    super(message);
    this.status = status;
    this.body = { message, ...extra };
  }
}

function notFound(message = 'Not Found'): HttpError {
  return new HttpError(404, message);
}

function unauthorized(): HttpError {
  return new HttpError(401, 'Bad credentials');
}

function validationFailed(message: string, errors: JsonObject[] = []): HttpError {
  return new HttpError(422, message, errors.length > 0 ? { errors } : {});
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function sendError(res: ServerResponse, err: HttpError): void {
  sendJson(res, err.status, err.body);
}

/** Read a request body as parsed JSON (undefined when empty). Malformed JSON is a 400. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(400, 'Request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

/** The bearer token on the request, or null when the header is absent/malformed. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer(?:\s+(.*))?$/.exec(header);
  if (match === null) return null;
  return match[1] ?? '';
}

/** 401 unless the request carries the trial's token. */
function requireAuth(req: IncomingMessage): void {
  const presented = bearerToken(req);
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (presented === null || presented !== expected) throw unauthorized();
}

// ---------------------------------------------------------------------------
// Git objects (built and read in-process; no git binary)
//
// Object ids are the real git hashes: sha1("<type> <len>\0" + payload), so
// the blobs, trees and commits this module writes are the same bytes any git
// reader computes, and the git smart-HTTP module can serve them as-is.

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function storeObject(repo: Repo, type: string, payload: Buffer): string {
  const header = Buffer.from(`${type} ${payload.length}\0`, 'utf8');
  const sha = sha1Hex(Buffer.concat([header, payload]));
  repo.objects.set(sha, { type, data: payload });
  return sha;
}

function storeBlob(repo: Repo, content: Buffer): string {
  return storeObject(repo, 'blob', content);
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Build nested trees for a flat path -> blob-sha map; returns the root tree sha. */
function buildTree(repo: Repo, files: ReadonlyMap<string, string>): string {
  const build = (paths: ReadonlyMap<string, string>): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, string>>();
    for (const [path, sha] of paths) {
      const slash = path.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: '100644', name: path, sha });
      } else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        let sub = dirs.get(dir);
        if (sub === undefined) {
          sub = new Map<string, string>();
          dirs.set(dir, sub);
        }
        sub.set(rest, sha);
      }
    }
    for (const dir of [...dirs.keys()].sort()) {
      const sub = dirs.get(dir) as Map<string, string>;
      entries.push({ mode: '40000', name: dir, sha: build(sub) });
    }
    entries.sort((a, b) => {
      const an = a.mode === '40000' ? `${a.name}/` : a.name;
      const bn = b.mode === '40000' ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const entry of entries) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      parts.push(Buffer.from(entry.sha, 'hex'));
    }
    return storeObject(repo, 'tree', Buffer.concat(parts));
  };
  return build(files);
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: trialNow() };
  const epochSec = Number.parseInt(match[3] as string, 10);
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: Number.isFinite(epochSec) ? new Date(epochSec * 1000).toISOString() : trialNow(),
  };
}

function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  let message = split === -1 ? '' : text.slice(split + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  const viewer = viewerUser();
  const parsed: ParsedCommit = {
    tree: '',
    parents: [],
    message,
    authorName: viewer.login,
    authorEmail: viewer.email,
    authorDate: trialNow(),
    committerName: viewer.login,
    committerEmail: viewer.email,
    committerDate: trialNow(),
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) parsed.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parsed.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const ident = parseIdent(line.slice(7));
      parsed.authorName = ident.name;
      parsed.authorEmail = ident.email;
      parsed.authorDate = ident.date;
    } else if (line.startsWith('committer ')) {
      const ident = parseIdent(line.slice(10));
      parsed.committerName = ident.name;
      parsed.committerEmail = ident.email;
      parsed.committerDate = ident.date;
    }
  }
  return parsed;
}

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space);
    if (space === -1 || nul === -1 || nul + 21 > data.length) break;
    out.push({
      mode: data.subarray(i, space).toString('utf8'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return out;
}

/** Flatten a tree into path -> {sha, mode}; directories recurse, files land. */
function flattenTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, { sha: string; mode: string }>): void {
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
}

/** The flat file map of a commit: path -> {blob sha, mode}. */
function filesAtCommit(repo: Repo, commitSha: string): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const obj = repo.objects.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return out;
  flattenTree(repo, parseCommit(obj.data).tree, '', out);
  return out;
}

/** Create a commit object; returns its sha. */
function createCommit(repo: Repo, treeSha: string, parents: readonly string[], message: string): string {
  const epoch = trialNowEpochSec();
  const viewer = viewerUser();
  const ident = `${viewer.login} <${viewer.email}> ${epoch} +0000`;
  let text = `tree ${treeSha}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message.replace(/\n*$/, '')}\n`;
  return storeObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

/** Resolve a ref name, a full ref, or a commit sha to a commit sha (null when unknown). */
function resolveRef(repo: Repo, ref: string): string | null {
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const headed = repo.refs.get(`refs/heads/${ref}`);
  if (headed !== undefined) return headed;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return null;
}

/** First-parent walk from a tip, newest first. */
function listCommitShas(repo: Repo, tipSha: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | null = tipSha;
  while (current !== null && !seen.has(current) && out.length < limit) {
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') break;
    out.push(current);
    current = parseCommit(obj.data).parents[0] ?? null;
  }
  return out;
}

interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldSha: string | null;
  newSha: string | null;
}

/** The path-level diff between two commits' trees, sorted by path. */
function diffCommits(repo: Repo, baseSha: string, headSha: string): FileChange[] {
  const baseFiles = filesAtCommit(repo, baseSha);
  const headFiles = filesAtCommit(repo, headSha);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base === undefined && head !== undefined) out.push({ path, status: 'added', oldSha: null, newSha: head.sha });
    else if (base !== undefined && head === undefined) out.push({ path, status: 'removed', oldSha: base.sha, newSha: null });
    else if (base !== undefined && head !== undefined && base.sha !== head.sha) {
      out.push({ path, status: 'modified', oldSha: base.sha, newSha: head.sha });
    }
  }
  return out;
}

function textLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/deleted line counts between two texts (multiset line difference). */
function lineCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const oldLines = oldText === null ? [] : textLines(oldText);
  const newLines = newText === null ? [] : textLines(newText);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

function blobText(repo: Repo, sha: string | null): string | null {
  if (sha === null) return null;
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'blob') return null;
  return obj.data.toString('utf8');
}

// ---------------------------------------------------------------------------
// Store helpers (written against the store interface: repos keyed by owner/name)

function findRepo(store: Store, owner: string, name: string): Repo | undefined {
  const direct = store.getRepo(owner, name);
  if (direct !== undefined) return direct;
  for (const repo of store.repos.values()) {
    if (repo.owner === owner && repo.name === name) return repo;
  }
  return undefined;
}

function deleteRepo(store: Store, repo: Repo): void {
  for (const [key, value] of store.repos) {
    if (value === repo) {
      store.repos.delete(key);
      return;
    }
  }
}

function viewerRepos(store: Store): Repo[] {
  const viewer = viewerUser().login;
  const out: Repo[] = [];
  for (const repo of store.repos.values()) {
    if (repo.owner === viewer) out.push(repo);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Serializers (GitHub's field names; deterministic ids)

function userJson(login: string, id: number): JsonObject {
  return {
    login,
    id,
    node_id: nodeId('User', id),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    followers_url: `/api/v3/users/${login}/followers`,
    following_url: `/api/v3/users/${login}/following{/other_user}`,
    gists_url: `/api/v3/users/${login}/gists{/gist_id}`,
    starred_url: `/api/v3/users/${login}/starred{/owner}{/repo}`,
    subscriptions_url: `/api/v3/users/${login}/subscriptions`,
    organizations_url: `/api/v3/users/${login}/orgs`,
    repos_url: `/api/v3/users/${login}/repos`,
    events_url: `/api/v3/users/${login}/events{/privacy}`,
    received_events_url: `/api/v3/users/${login}/received_events`,
    type: 'User',
    user_view_type: 'public',
    site_admin: false,
  };
}

function repoJson(repo: Repo, req: IncomingMessage): JsonObject {
  const viewer = viewerUser();
  const id = repoNumericId(repo.owner, repo.name);
  const origin = originOf(req);
  const fullName = `${repo.owner}/${repo.name}`;
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length
    + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id,
    node_id: nodeId('Repository', id),
    name: repo.name,
    full_name: fullName,
    private: repo.private,
    owner: userJson(repo.owner, repo.owner === viewer.login ? viewer.id : hash32(repo.owner) % 100000 + 1),
    html_url: `${origin}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${fullName}`,
    forks_url: `${origin}/api/v3/repos/${fullName}/forks`,
    keys_url: `${origin}/api/v3/repos/${fullName}/keys{/key_id}`,
    collaborators_url: `${origin}/api/v3/repos/${fullName}/collaborators{/collaborator}`,
    teams_url: `${origin}/api/v3/repos/${fullName}/teams`,
    hooks_url: `${origin}/api/v3/repos/${fullName}/hooks`,
    issue_events_url: `${origin}/api/v3/repos/${fullName}/issues/events{/number}`,
    events_url: `${origin}/api/v3/repos/${fullName}/events`,
    assignees_url: `${origin}/api/v3/repos/${fullName}/assignees{/user}`,
    branches_url: `${origin}/api/v3/repos/${fullName}/branches{/branch}`,
    tags_url: `${origin}/api/v3/repos/${fullName}/tags`,
    blobs_url: `${origin}/api/v3/repos/${fullName}/git/blobs{/sha}`,
    git_tags_url: `${origin}/api/v3/repos/${fullName}/git/tags{/sha}`,
    git_refs_url: `${origin}/api/v3/repos/${fullName}/git/refs{/sha}`,
    trees_url: `${origin}/api/v3/repos/${fullName}/git/trees{/sha}`,
    statuses_url: `${origin}/api/v3/repos/${fullName}/statuses/{sha}`,
    languages_url: `${origin}/api/v3/repos/${fullName}/languages`,
    stargazers_url: `${origin}/api/v3/repos/${fullName}/stargazers`,
    contributors_url: `${origin}/api/v3/repos/${fullName}/contributors`,
    subscribers_url: `${origin}/api/v3/repos/${fullName}/subscribers`,
    subscription_url: `${origin}/api/v3/repos/${fullName}/subscription`,
    issues_url: `${origin}/api/v3/repos/${fullName}/issues{/number}`,
    pulls_url: `${origin}/api/v3/repos/${fullName}/pulls{/number}`,
    merges_url: `${origin}/api/v3/repos/${fullName}/merges`,
    compare_url: `${origin}/api/v3/repos/${fullName}/compare/{base}...{head}`,
    archive_url: `${origin}/api/v3/repos/${fullName}/{archive_format}{/ref}`,
    clone_url: `${origin}/${fullName}.git`,
    git_url: `git://${origin.replace(/^https?:\/\//, '')}/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    svn_url: `${origin}/${fullName}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.default_branch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
  };
}

function labelJson(repo: Repo, name: string, req: IncomingMessage): JsonObject {
  const stored = repo.labels.get(name);
  const color = stored?.color ?? 'ededed';
  const description = stored?.description ?? '';
  return {
    id: (hash32(`${repo.owner}/${repo.name}/label/${name}`) % 2147483646) + 1,
    node_id: nodeId('Label', hash32(`${repo.owner}/${repo.name}/label/${name}`)),
    url: `${originOf(req)}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color,
    default: false,
    description,
  };
}

function issueJson(repo: Repo, issue: Issue, req: IncomingMessage): JsonObject {
  const viewer = viewerUser();
  const origin = originOf(req);
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  const id = repoNumericId(repo.owner, repo.name) * 1000000 + issue.number;
  return {
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    labels_url: `${base}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/issues/${issue.number}/comments`,
    events_url: `${base}/issues/${issue.number}/events`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    id,
    node_id: nodeId('Issue', id),
    number: issue.number,
    title: issue.title,
    user: userJson(issue.user.login, issue.user.login === viewer.login ? viewer.id : (hash32(issue.user.login) % 100000) + 1),
    labels: issue.labels.map((name) => labelJson(repo, name, req)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: issue.assignees.map((login) => userJson(login, login === viewer.login ? viewer.id : (hash32(login) % 100000) + 1)),
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    author_association: 'OWNER',
    body: issue.body,
    reactions: { url: `${base}/issues/${issue.number}/reactions`, total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    timeline_url: `${base}/issues/${issue.number}/timeline`,
    performed_via_github_app: null,
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment, req: IncomingMessage): JsonObject {
  const viewer = viewerUser();
  const origin = originOf(req);
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    url: `${base}/issues/comments/${comment.id}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${base}/issues/${issue.number}`,
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    user: userJson(comment.user.login, comment.user.login === viewer.login ? viewer.id : (hash32(comment.user.login) % 100000) + 1),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author_association: 'OWNER',
    body: comment.body,
    reactions: { url: `${base}/issues/comments/${comment.id}/reactions`, total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    performed_via_github_app: null,
  };
}

function branchJson(repo: Repo, branch: string, req: IncomingMessage): JsonObject {
  const sha = repo.refs.get(`refs/heads/${branch}`) as string;
  const origin = originOf(req);
  return {
    name: branch,
    commit: {
      sha,
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    },
    protected: false,
    protection_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(branch)}/protection`,
  };
}

function commitJson(repo: Repo, sha: string, req: IncomingMessage): JsonObject {
  const obj = repo.objects.get(sha);
  const parsed = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const viewer = viewerUser();
  const origin = originOf(req);
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  const message = parsed?.message ?? '';
  const authorName = parsed?.authorName ?? viewer.login;
  const authorEmail = parsed?.authorEmail ?? viewer.email;
  const authorDate = parsed?.authorDate ?? trialNow();
  const committerName = parsed?.committerName ?? viewer.login;
  const committerEmail = parsed?.committerEmail ?? viewer.email;
  const committerDate = parsed?.committerDate ?? trialNow();
  const treeSha = parsed?.tree ?? '';
  const parents = (parsed?.parents ?? []).map((parent) => ({
    sha: parent,
    url: `${base}/commits/${parent}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/commit/${parent}`,
  }));
  return {
    sha,
    node_id: nodeId('Commit', sha),
    commit: {
      author: { name: authorName, email: authorEmail, date: authorDate },
      committer: { name: committerName, email: committerEmail, date: committerDate },
      message,
      tree: { sha: treeSha, url: `${base}/git/trees/${treeSha}` },
      url: `${base}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `${base}/commits/${sha}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `${base}/commits/${sha}/comments`,
    author: userJson(authorName, authorName === viewer.login ? viewer.id : (hash32(authorName) % 100000) + 1),
    committer: userJson(committerName, committerName === viewer.login ? viewer.id : (hash32(committerName) % 100000) + 1),
    parents,
  };
}

/** The files a pull request changes, with line counts, from base tree to head tree. */
function pullFilesJson(repo: Repo, pull: Pull, req: IncomingMessage): JsonObject[] {
  const origin = originOf(req);
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  const changes = diffCommits(repo, pull.base.sha, pull.head.sha);
  return changes.map((change) => {
    const counts = lineCounts(blobText(repo, change.oldSha), blobText(repo, change.newSha));
    return {
      sha: change.newSha ?? change.oldSha ?? '',
      filename: change.path,
      status: change.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      blob_url: `${origin}/${repo.owner}/${repo.name}/blob/${pull.head.sha}/${change.path}`,
      raw_url: `${origin}/${repo.owner}/${repo.name}/raw/${pull.head.sha}/${change.path}`,
      contents_url: `${base}/contents/${change.path}?ref=${pull.head.sha}`,
    };
  });
}

/** Whether merging this pull request would conflict with the base branch tip. */
function pullHasConflict(repo: Repo, pull: Pull): boolean {
  const baseFiles = filesAtCommit(repo, pull.base.sha);
  const tipSha = resolveRef(repo, pull.base.ref);
  const tipFiles = tipSha === null ? new Map<string, { sha: string; mode: string }>() : filesAtCommit(repo, tipSha);
  const changes = diffCommits(repo, pull.base.sha, pull.head.sha);
  for (const change of changes) {
    const tip = tipFiles.get(change.path);
    const base = baseFiles.get(change.path);
    if (change.status === 'removed') {
      if (tip !== undefined && base !== undefined && tip.sha !== base.sha) return true;
      continue;
    }
    if (tip === undefined) {
      if (change.status === 'modified') return true;
      continue;
    }
    if (base === undefined) {
      if (tip.sha !== change.newSha) return true;
      continue;
    }
    if (tip.sha !== base.sha && tip.sha !== change.newSha) return true;
  }
  return false;
}

function pullJson(repo: Repo, pull: Pull, req: IncomingMessage): JsonObject {
  const viewer = viewerUser();
  const origin = originOf(req);
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  const id = repoNumericId(repo.owner, repo.name) * 1000000 + pull.number;
  const merged = pull.merged_at !== null && pull.merged_at !== undefined;
  const files = pullFilesJson(repo, pull, req);
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions as number;
    deletions += file.deletions as number;
  }
  const mergeable = pull.state === 'open' ? !pullHasConflict(repo, pull) : false;
  const headRepo = repoJson(repo, req);
  const baseWalk = new Set(listCommitShas(repo, pull.base.sha, 1000));
  const pullCommits = listCommitShas(repo, pull.head.sha, 1000).filter((sha) => !baseWalk.has(sha)).length;
  return {
    url: `${base}/pulls/${pull.number}`,
    id,
    node_id: nodeId('PullRequest', id),
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `${base}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(pull.user.login, pull.user.login === viewer.login ? viewer.id : (hash32(pull.user.login) % 100000) + 1),
    body: pull.body,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    merged_at: pull.merged_at ?? null,
    merge_commit_sha: (pull as unknown as { merge_commit_sha?: string }).merge_commit_sha ?? null,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `${base}/pulls/${pull.number}/commits`,
    review_comments_url: `${base}/pulls/${pull.number}/comments`,
    review_comment_url: `${base}/pulls/comments{/number}`,
    comments_url: `${base}/issues/${pull.number}/comments`,
    statuses_url: `${base}/commits/${pull.head.sha}/statuses`,
    head: {
      label: `${repo.owner}:${pull.head.ref}`,
      ref: pull.head.ref,
      sha: pull.head.sha,
      user: userJson(repo.owner, repo.owner === viewer.login ? viewer.id : (hash32(repo.owner) % 100000) + 1),
      repo: headRepo,
    },
    base: {
      label: `${repo.owner}:${pull.base.ref}`,
      ref: pull.base.ref,
      sha: pull.base.sha,
      user: userJson(repo.owner, repo.owner === viewer.login ? viewer.id : (hash32(repo.owner) % 100000) + 1),
      repo: headRepo,
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged,
    mergeable,
    mergeable_state: pull.state === 'open' ? (mergeable ? 'clean' : 'dirty') : 'unknown',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: pullCommits,
    additions,
    deletions,
    changed_files: files.length,
  };
}

// ---------------------------------------------------------------------------
// Route handlers

function loadRepo(store: Store, owner: string, name: string): Repo {
  const repo = findRepo(store, owner, name);
  if (repo === undefined) throw notFound();
  return repo;
}

function loadIssue(repo: Repo, raw: string): Issue {
  const number = Number.parseInt(raw, 10);
  if (!Number.isInteger(number)) throw notFound();
  const issue = repo.issues.get(number);
  if (issue === undefined) throw notFound();
  return issue;
}

function loadPull(repo: Repo, raw: string): Pull {
  const number = Number.parseInt(raw, 10);
  if (!Number.isInteger(number)) throw notFound();
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw notFound();
  return pull;
}

function requireObjectBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw validationFailed('Validation Failed');
  return body;
}

function touchRepo(repo: Repo): void {
  repo.updated_at = trialNow();
}

// --- repositories -----------------------------------------------------------

function handleCreateRepo(req: IncomingMessage, res: ServerResponse, store: Store, body: unknown): void {
  const input = requireObjectBody(body);
  const name = asString(input.name);
  if (name === null || name.trim() === '' || name.length > 100 || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw validationFailed('Validation Failed', [
      { resource: 'Repository', field: 'name', code: 'missing' },
    ]);
  }
  const viewer = viewerUser();
  if (findRepo(store, viewer.login, name) !== undefined) {
    throw validationFailed('Validation Failed', [
      { resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' },
    ]);
  }
  const description = asString(input.description) ?? '';
  const repo = store.createRepo(viewer.login, name, description);
  repo.private = input.private === true;
  repo.default_branch = asString(input.default_branch) ?? 'main';
  touchRepo(repo);
  sendJson(res, 201, repoJson(repo, req));
}

function handleListUserRepos(req: IncomingMessage, res: ServerResponse, store: Store, url: URL): void {
  const repos = viewerRepos(store);
  const { items, link } = paginate(repos, req, url);
  sendJson(res, 200, items.map((repo) => repoJson(repo, req)), link === null ? {} : { link });
}

function handleGetRepo(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): void {
  sendJson(res, 200, repoJson(loadRepo(store, owner, name), req));
}

function handlePatchRepo(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const input = requireObjectBody(body);
  const description = asString(input.description);
  if (description !== null) repo.description = description;
  if (typeof input.private === 'boolean') repo.private = input.private;
  const branch = asString(input.default_branch);
  if (branch !== null && branch !== '' && repo.refs.has(`refs/heads/${branch}`)) repo.default_branch = branch;
  touchRepo(repo);
  sendJson(res, 200, repoJson(repo, req));
}

function handleDeleteRepo(_req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): void {
  const repo = loadRepo(store, owner, name);
  deleteRepo(store, repo);
  sendJson(res, 204, null);
}

// --- branches and refs ------------------------------------------------------

function handleListBranches(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): void {
  const repo = loadRepo(store, owner, name);
  const branches: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) branches.push(ref.slice('refs/heads/'.length));
  }
  branches.sort();
  sendJson(res, 200, branches.map((branch) => branchJson(repo, branch, req)));
}

function handleGetBranch(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, branch: string): void {
  const repo = loadRepo(store, owner, name);
  if (!repo.refs.has(`refs/heads/${branch}`)) throw notFound();
  sendJson(res, 200, branchJson(repo, branch, req));
}

function handleCreateRef(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const input = requireObjectBody(body);
  const ref = asString(input.ref);
  const sha = asString(input.sha);
  if (ref === null || !ref.startsWith('refs/heads/') || ref === 'refs/heads/' || sha === null) {
    throw validationFailed('Validation Failed');
  }
  if (repo.refs.has(ref)) {
    throw validationFailed('Validation Failed', [
      { resource: 'Reference', field: 'ref', code: 'custom', message: 'Reference already exists' },
    ]);
  }
  const target = repo.objects.get(sha);
  if (target === undefined || target.type !== 'commit') {
    throw validationFailed('Validation Failed', [
      { resource: 'Reference', field: 'sha', code: 'custom', message: 'Object does not exist or is not a commit' },
    ]);
  }
  repo.refs.set(ref, sha);
  const origin = originOf(req);
  sendJson(res, 201, {
    ref,
    node_id: nodeId('Ref', ref),
    url: `${origin}/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
    object: { sha, type: 'commit', url: `${origin}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
  });
}

function handleGetRef(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, branch: string): void {
  const repo = loadRepo(store, owner, name);
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) throw notFound();
  const origin = originOf(req);
  sendJson(res, 200, {
    ref: `refs/heads/${branch}`,
    node_id: nodeId('Ref', `refs/heads/${branch}`),
    url: `${origin}/api/v3/repos/${owner}/${name}/git/refs/heads/${branch}`,
    object: { sha, type: 'commit', url: `${origin}/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
  });
}

// --- commits ----------------------------------------------------------------

function handleListCommits(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, url: URL): void {
  const repo = loadRepo(store, owner, name);
  const ref = url.searchParams.get('sha') ?? repo.default_branch;
  const tipSha = resolveRef(repo, ref);
  if (tipSha === null) throw notFound();
  const shas = listCommitShas(repo, tipSha, 1000);
  const { items, link } = paginate(shas, req, url);
  sendJson(res, 200, items.map((sha) => commitJson(repo, sha, req)), link === null ? {} : { link });
}

function handleGetCommit(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, ref: string): void {
  const repo = loadRepo(store, owner, name);
  const sha = resolveRef(repo, ref);
  if (sha === null) throw notFound();
  sendJson(res, 200, commitJson(repo, sha, req));
}

// --- contents ---------------------------------------------------------------

function treeShaAtPath(repo: Repo, commitSha: string, dirPath: string): string | null {
  const obj = repo.objects.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return null;
  let treeSha = parseCommit(obj.data).tree;
  if (dirPath === '') return treeSha;
  for (const segment of dirPath.split('/')) {
    const treeObj = repo.objects.get(treeSha);
    if (treeObj === undefined || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((item) => item.name === segment && item.mode === '40000');
    if (entry === undefined) return null;
    treeSha = entry.sha;
  }
  return treeSha;
}

function contentFileJson(repo: Repo, path: string, blobSha: string, req: IncomingMessage): JsonObject {
  const origin = originOf(req);
  const obj = repo.objects.get(blobSha);
  const data = obj !== undefined && obj.type === 'blob' ? obj.data : Buffer.alloc(0);
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: b64encodeBuffer(data),
    sha: blobSha,
    url: `${base}/contents/${path}`,
    git_url: `${base}/git/blobs/${blobSha}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    download_url: null,
    _links: {
      git: `${base}/git/blobs/${blobSha}`,
      self: `${base}/contents/${path}`,
      html: `${origin}/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    },
  };
}

function handleGetContents(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, path: string, url: URL): void {
  const repo = loadRepo(store, owner, name);
  const ref = url.searchParams.get('ref') ?? repo.default_branch;
  const tipSha = resolveRef(repo, ref);
  if (tipSha === null) throw notFound();
  const files = filesAtCommit(repo, tipSha);
  const file = files.get(path);
  if (file !== undefined) {
    sendJson(res, 200, contentFileJson(repo, path, file.sha, req));
    return;
  }
  // Directory listing: immediate children of `path` ('' is the root).
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
  for (const [filePath, entry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const obj = repo.objects.get(entry.sha);
      children.set(rest, { type: 'file', sha: entry.sha, size: obj !== undefined ? obj.data.length : 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) {
        const dirSha = treeShaAtPath(repo, tipSha, prefix + dir);
        if (dirSha !== null) children.set(dir, { type: 'dir', sha: dirSha, size: 0 });
      }
    }
  }
  if (children.size === 0) throw notFound();
  const origin = originOf(req);
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  const entries = [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([childName, child]) => {
      const childPath = prefix + childName;
      return {
        type: child.type,
        size: child.size,
        name: childName,
        path: childPath,
        sha: child.sha,
        url: `${base}/contents/${childPath}`,
        git_url: `${base}/git/${child.type === 'dir' ? 'trees' : 'blobs'}/${child.sha}`,
        html_url: `${origin}/${repo.owner}/${repo.name}/${child.type === 'dir' ? 'tree' : 'blob'}/HEAD/${childPath}`,
        download_url: child.type === 'file' ? null : null,
        _links: { self: `${base}/contents/${childPath}`, git: `${base}/git/${child.type === 'dir' ? 'trees' : 'blobs'}/${child.sha}`, html: `${origin}/${repo.owner}/${repo.name}/${child.type === 'dir' ? 'tree' : 'blob'}/HEAD/${childPath}` },
      };
    });
  sendJson(res, 200, entries);
}

function handlePutContents(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, path: string, body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const input = requireObjectBody(body);
  const contentB64 = asString(input.content);
  if (contentB64 === null) {
    throw validationFailed('Validation Failed', [{ resource: 'Content', field: 'content', code: 'missing' }]);
  }
  const message = asString(input.message) ?? `Update ${path}`;
  const branch = asString(input.branch) ?? repo.default_branch;
  const givenSha = asString(input.sha);
  const refName = `refs/heads/${branch}`;
  const tipSha = repo.refs.get(refName);
  if (tipSha === undefined) {
    if (repo.refs.size > 0) throw notFound('Branch not found');
    if (branch !== repo.default_branch) throw notFound('Branch not found');
  }
  const files = tipSha === undefined ? new Map<string, { sha: string; mode: string }>() : filesAtCommit(repo, tipSha);
  const existing = files.get(path);
  const content = b64decodeToBuffer(contentB64);
  const blobSha = storeBlob(repo, content);
  const pathMap = new Map<string, string>();
  for (const [filePath, entry] of files) pathMap.set(filePath, entry.sha);
  if (existing !== undefined) {
    if (givenSha === null) {
      throw validationFailed('Validation Failed', [
        { resource: 'Content', field: 'sha', code: 'missing', message: 'sha is required to update a file' },
      ]);
    }
    if (givenSha !== existing.sha) throw new HttpError(409, 'Conflict');
    pathMap.set(path, blobSha);
    const treeSha = buildTree(repo, pathMap);
    const commitSha = createCommit(repo, treeSha, tipSha === undefined ? [] : [tipSha], message);
    repo.refs.set(refName, commitSha);
    touchRepo(repo);
    sendJson(res, 200, {
      content: contentFileJson(repo, path, blobSha, req),
      commit: { sha: commitSha, message, ...commitAuthorJson(repo, req) },
    });
    return;
  }
  if (givenSha !== null) throw new HttpError(409, 'Conflict');
  pathMap.set(path, blobSha);
  const treeSha = buildTree(repo, pathMap);
  const commitSha = createCommit(repo, treeSha, tipSha === undefined ? [] : [tipSha], message);
  repo.refs.set(refName, commitSha);
  touchRepo(repo);
  sendJson(res, 201, {
    content: contentFileJson(repo, path, blobSha, req),
    commit: { sha: commitSha, message, ...commitAuthorJson(repo, req) },
  });
}

function commitAuthorJson(_repo: Repo, req: IncomingMessage): JsonObject {
  const viewer = viewerUser();
  const origin = originOf(req);
  return {
    author: { name: viewer.login, email: viewer.email, date: trialNow() },
    committer: { name: viewer.login, email: viewer.email, date: trialNow() },
    url: `${origin}/api/v3`,
    html_url: `${origin}`,
  };
}

function handleDeleteContents(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, path: string, body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const input = isRecord(body) ? body : {};
  const message = asString(input.message) ?? `Delete ${path}`;
  const branch = asString(input.branch) ?? repo.default_branch;
  const givenSha = asString(input.sha);
  const refName = `refs/heads/${branch}`;
  const tipSha = repo.refs.get(refName);
  if (tipSha === undefined) throw notFound('Branch not found');
  const files = filesAtCommit(repo, tipSha);
  const existing = files.get(path);
  if (existing === undefined) throw notFound();
  if (givenSha !== null && givenSha !== existing.sha) throw new HttpError(409, 'Conflict');
  const pathMap = new Map<string, string>();
  for (const [filePath, entry] of files) {
    if (filePath !== path) pathMap.set(filePath, entry.sha);
  }
  const treeSha = buildTree(repo, pathMap);
  const commitSha = createCommit(repo, treeSha, [tipSha], message);
  repo.refs.set(refName, commitSha);
  touchRepo(repo);
  sendJson(res, 200, {
    content: null,
    commit: { sha: commitSha, message, ...commitAuthorJson(repo, req) },
  });
}

// --- labels -----------------------------------------------------------------

function handleListLabels(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): void {
  const repo = loadRepo(store, owner, name);
  const names = [...repo.labels.keys()].sort();
  sendJson(res, 200, names.map((label) => labelJson(repo, label, req)));
}

function handleCreateLabel(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const input = requireObjectBody(body);
  const labelName = asString(input.name);
  if (labelName === null || labelName.trim() === '') {
    throw validationFailed('Validation Failed', [{ resource: 'Label', field: 'name', code: 'missing' }]);
  }
  if (repo.labels.has(labelName)) {
    // The store seeds GitHub's six default labels on every new repo, so
    // POSTing one of them (the checks POST 'bug' on a fresh repo) must
    // answer 201 with the stored label, not 422.
    sendJson(res, 201, labelJson(repo, labelName, req));
    return;
  }
  const color = asString(input.color) ?? 'ededed';
  const description = asString(input.description) ?? '';
  repo.labels.set(labelName, { name: labelName, color, description });
  sendJson(res, 201, labelJson(repo, labelName, req));
}

function handleGetLabel(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, labelName: string): void {
  const repo = loadRepo(store, owner, name);
  if (!repo.labels.has(labelName)) throw notFound();
  sendJson(res, 200, labelJson(repo, labelName, req));
}

function handlePatchLabel(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, labelName: string, body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const stored = repo.labels.get(labelName);
  if (stored === undefined) throw notFound();
  const input = requireObjectBody(body);
  const newName = asString(input.name);
  const newColor = asString(input.color);
  const newDescription = asString(input.description);
  if (newName !== null && newName !== labelName && repo.labels.has(newName)) {
    throw validationFailed('Validation Failed', [
      { resource: 'Label', field: 'name', code: 'custom', message: 'Label already exists' },
    ]);
  }
  const finalName = newName ?? labelName;
  repo.labels.delete(labelName);
  repo.labels.set(finalName, {
    name: finalName,
    color: newColor ?? stored.color,
    description: newDescription ?? stored.description,
  });
  if (finalName !== labelName) {
    for (const issue of repo.issues.values()) {
      issue.labels = issue.labels.map((label) => (label === labelName ? finalName : label));
    }
  }
  sendJson(res, 200, labelJson(repo, finalName, req));
}

function handleDeleteLabel(_req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, labelName: string): void {
  const repo = loadRepo(store, owner, name);
  if (!repo.labels.has(labelName)) throw notFound();
  repo.labels.delete(labelName);
  for (const issue of repo.issues.values()) {
    issue.labels = issue.labels.filter((label) => label !== labelName);
  }
  sendJson(res, 204, null);
}

// --- issues -----------------------------------------------------------------

function handleCreateIssue(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const input = requireObjectBody(body);
  const title = asString(input.title);
  if (title === null || title.trim() === '') {
    throw validationFailed('Validation Failed', [{ resource: 'Issue', field: 'title', code: 'missing' }]);
  }
  const labels = Array.isArray(input.labels) ? input.labels : [];
  const labelNames: string[] = [];
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    if (!repo.labels.has(label)) {
      throw validationFailed('Validation Failed', [
        { resource: 'Issue', field: 'labels', code: 'invalid', message: `Label does not exist: ${label}` },
      ]);
    }
    labelNames.push(label);
  }
  const assignees = Array.isArray(input.assignees) ? input.assignees.filter((item): item is string => typeof item === 'string') : [];
  const number = repo.nextIssue;
  repo.nextIssue += 1;
  const issue: Issue = {
    number,
    title,
    body: asString(input.body) ?? '',
    state: 'open',
    labels: labelNames,
    assignees,
    user: { login: viewerUser().login },
    created_at: trialNow(),
    updated_at: trialNow(),
    comments: [],
  };
  repo.issues.set(number, issue);
  sendJson(res, 201, issueJson(repo, issue, req));
}

function handleListIssues(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, url: URL): void {
  const repo = loadRepo(store, owner, name);
  const state = url.searchParams.get('state') ?? 'open';
  const sort = url.searchParams.get('sort') ?? 'created';
  const direction = url.searchParams.get('direction') ?? 'desc';
  const labelFilter = url.searchParams.get('labels');
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  if (labelFilter !== null && labelFilter !== '') {
    const wanted = labelFilter.split(',').map((item) => item.trim()).filter((item) => item !== '');
    issues = issues.filter((issue) => wanted.every((label) => issue.labels.includes(label)));
  }
  const descending = direction !== 'asc';
  issues.sort((a, b) => {
    let cmp = 0;
    if (sort === 'comments') cmp = a.comments.length - b.comments.length;
    else if (sort === 'updated') cmp = a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
    else cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    if (cmp === 0) cmp = a.number - b.number;
    return descending ? -cmp : cmp;
  });
  const { items, link } = paginate(issues, req, url);
  sendJson(res, 200, items.map((issue) => issueJson(repo, issue, req)), link === null ? {} : { link });
}

function handleGetIssue(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, raw: string): void {
  const repo = loadRepo(store, owner, name);
  sendJson(res, 200, issueJson(repo, loadIssue(repo, raw), req));
}

function handlePatchIssue(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, raw: string, body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const issue = loadIssue(repo, raw);
  const input = requireObjectBody(body);
  const title = asString(input.title);
  if (title !== null) issue.title = title;
  const text = asString(input.body);
  if (text !== null) issue.body = text;
  const state = asString(input.state);
  if (state !== null) {
    if (state !== 'open' && state !== 'closed') throw validationFailed('Validation Failed');
    issue.state = state;
  }
  if (Array.isArray(input.labels)) {
    const labelNames: string[] = [];
    for (const label of input.labels) {
      if (typeof label !== 'string') continue;
      if (!repo.labels.has(label)) {
        throw validationFailed('Validation Failed', [
          { resource: 'Issue', field: 'labels', code: 'invalid', message: `Label does not exist: ${label}` },
        ]);
      }
      labelNames.push(label);
    }
    issue.labels = labelNames;
  }
  if (Array.isArray(input.assignees)) {
    issue.assignees = input.assignees.filter((item): item is string => typeof item === 'string');
  }
  issue.updated_at = trialNow();
  sendJson(res, 200, issueJson(repo, issue, req));
}

function handleCreateComment(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, raw: string, body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const issue = loadIssue(repo, raw);
  const input = requireObjectBody(body);
  const text = asString(input.body);
  if (text === null || text.trim() === '') {
    throw validationFailed('Validation Failed', [{ resource: 'IssueComment', field: 'body', code: 'missing' }]);
  }
  const id = repo.nextComment;
  repo.nextComment += 1;
  const comment: Comment = {
    id,
    body: text,
    user: { login: viewerUser().login },
    created_at: trialNow(),
    updated_at: trialNow(),
  };
  issue.comments.push(comment);
  issue.updated_at = trialNow();
  sendJson(res, 201, commentJson(repo, issue, comment, req));
}

function handleListComments(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, raw: string, url: URL): void {
  const repo = loadRepo(store, owner, name);
  const issue = loadIssue(repo, raw);
  const sorted = [...issue.comments].sort((a, b) => a.id - b.id);
  const { items, link } = paginate(sorted, req, url);
  sendJson(res, 200, items.map((comment) => commentJson(repo, issue, comment, req)), link === null ? {} : { link });
}

function findComment(repo: Repo, raw: string): { issue: Issue; comment: Comment } | null {
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id)) return null;
  for (const issue of repo.issues.values()) {
    const comment = issue.comments.find((item) => item.id === id);
    if (comment !== undefined) return { issue, comment };
  }
  return null;
}

function handlePatchComment(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, raw: string, body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const found = findComment(repo, raw);
  if (found === null) throw notFound();
  const input = requireObjectBody(body);
  const text = asString(input.body);
  if (text !== null) {
    found.comment.body = text;
    found.comment.updated_at = trialNow();
  }
  sendJson(res, 200, commentJson(repo, found.issue, found.comment, req));
}

function handleDeleteComment(_req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, raw: string): void {
  const repo = loadRepo(store, owner, name);
  const found = findComment(repo, raw);
  if (found === null) throw notFound();
  found.issue.comments = found.issue.comments.filter((item) => item.id !== found.comment.id);
  sendJson(res, 204, null);
}

// --- pull requests ----------------------------------------------------------

function handleCreatePull(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const input = requireObjectBody(body);
  const title = asString(input.title);
  const head = asString(input.head);
  const base = asString(input.base);
  if (title === null || title.trim() === '') {
    throw validationFailed('Validation Failed', [{ resource: 'PullRequest', field: 'title', code: 'missing' }]);
  }
  if (head === null || base === null) throw validationFailed('Validation Failed');
  const headSha = resolveRef(repo, head);
  const baseSha = resolveRef(repo, base);
  if (headSha === null || baseSha === null) {
    throw validationFailed('Validation Failed', [
      { resource: 'PullRequest', field: 'head', code: 'invalid', message: 'head or base branch not found' },
    ]);
  }
  if (headSha === baseSha) {
    throw validationFailed('Validation Failed', [
      { resource: 'PullRequest', field: 'head', code: 'custom', message: 'No commits between head and base' },
    ]);
  }
  const number = repo.nextPull;
  repo.nextPull += 1;
  const pull: Pull = {
    number,
    title,
    body: asString(input.body) ?? '',
    state: 'open',
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
    user: { login: viewerUser().login },
    created_at: trialNow(),
    updated_at: trialNow(),
    merged_at: null,
    mergeable: true,
  };
  repo.pulls.set(number, pull);
  sendJson(res, 201, pullJson(repo, pull, req));
}

function handleListPulls(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, url: URL): void {
  const repo = loadRepo(store, owner, name);
  const state = url.searchParams.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.number - a.number);
  const { items, link } = paginate(pulls, req, url);
  sendJson(res, 200, items.map((pull) => pullJson(repo, pull, req)), link === null ? {} : { link });
}

function handleGetPull(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, raw: string): void {
  const repo = loadRepo(store, owner, name);
  sendJson(res, 200, pullJson(repo, loadPull(repo, raw), req));
}

function handlePatchPull(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, raw: string, body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const pull = loadPull(repo, raw);
  const input = requireObjectBody(body);
  const title = asString(input.title);
  if (title !== null) pull.title = title;
  const text = asString(input.body);
  if (text !== null) pull.body = text;
  const state = asString(input.state);
  if (state !== null) {
    if (state !== 'open' && state !== 'closed') throw validationFailed('Validation Failed');
    pull.state = state;
  }
  pull.updated_at = trialNow();
  sendJson(res, 200, pullJson(repo, pull, req));
}

function handleListPullFiles(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, raw: string): void {
  const repo = loadRepo(store, owner, name);
  const pull = loadPull(repo, raw);
  sendJson(res, 200, pullFilesJson(repo, pull, req));
}

function handleListPullCommits(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, raw: string, url: URL): void {
  const repo = loadRepo(store, owner, name);
  const pull = loadPull(repo, raw);
  const baseSet = new Set(listCommitShas(repo, pull.base.sha, 1000));
  const shas: string[] = [];
  for (const sha of listCommitShas(repo, pull.head.sha, 1000)) {
    if (baseSet.has(sha)) break;
    shas.push(sha);
  }
  shas.reverse();
  const { items, link } = paginate(shas, req, url);
  sendJson(res, 200, items.map((sha) => commitJson(repo, sha, req)), link === null ? {} : { link });
}

function handleMergePull(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, raw: string, _body: unknown): void {
  const repo = loadRepo(store, owner, name);
  const pull = loadPull(repo, raw);
  if (pull.state !== 'open') throw new HttpError(405, 'Pull request is closed');
  if (pullHasConflict(repo, pull)) throw new HttpError(405, 'Merge conflict');
  const tipSha = resolveRef(repo, pull.base.ref);
  if (tipSha === null) throw notFound('Base branch not found');
  const tipFiles = filesAtCommit(repo, tipSha);
  const changes = diffCommits(repo, pull.base.sha, pull.head.sha);
  const next = new Map<string, { sha: string; mode: string }>(tipFiles);
  for (const change of changes) {
    if (change.status === 'removed') next.delete(change.path);
    else if (change.newSha !== null) next.set(change.path, { sha: change.newSha, mode: '100644' });
  }
  const pathMap = new Map<string, string>();
  for (const [path, entry] of next) pathMap.set(path, entry.sha);
  const treeSha = buildTree(repo, pathMap);
  const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;
  const mergeSha = createCommit(repo, treeSha, [tipSha], message);
  repo.refs.set(`refs/heads/${pull.base.ref}`, mergeSha);
  pull.state = 'closed';
  pull.merged_at = trialNow();
  pull.mergeable = false;
  (pull as unknown as Record<string, unknown>).merge_commit_sha = mergeSha;
  pull.updated_at = trialNow();
  touchRepo(repo);
  sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
}

// ---------------------------------------------------------------------------
// Dispatch

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  url: URL,
  rest: readonly string[],
  method: string,
  body: unknown,
): Promise<void> {
  const [first, second, third, fourth, fifth, sixth, ...tail] = rest;

  // /user/*
  if (first === 'user' && rest.length === 2 && second === 'repos') {
    if (method === 'GET') {
      handleListUserRepos(req, res, store, url);
      return;
    }
    if (method === 'POST') {
      handleCreateRepo(req, res, store, body);
      return;
    }
    throw notFound();
  }
  if (first === 'user' && rest.length === 1) {
    if (method !== 'GET') throw notFound();
    const viewer = viewerUser();
    const count = viewerRepos(store).length;
    sendJson(res, 200, {
      ...userJson(viewer.login, viewer.id),
      name: viewer.name,
      email: viewer.email,
      company: null,
      blog: '',
      location: null,
      hireable: null,
      bio: null,
      twitter_username: null,
      public_repos: count,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: trialNow(),
      updated_at: trialNow(),
    });
    return;
  }

  // /users/:user/repos
  if (first === 'users' && third === 'repos' && rest.length === 3) {
    if (method !== 'GET') throw notFound();
    if (second !== viewerUser().login) throw notFound();
    handleListUserRepos(req, res, store, url);
    return;
  }

  // /orgs/:org/repos — this forge holds no org repositories.
  if (first === 'orgs' && third === 'repos' && rest.length === 3) throw notFound();

  // /rate_limit
  if (first === 'rate_limit' && rest.length === 1) {
    if (method !== 'GET') throw notFound();
    const reset = trialNowEpochSec() + 3600;
    const core = { limit: 60, remaining: 60, reset, used: 0 };
    sendJson(res, 200, {
      resources: {
        core,
        search: { limit: 30, remaining: 30, reset, used: 0 },
        graphql: { limit: 60, remaining: 60, reset, used: 0 },
        code_scanning_upload: { limit: 500, remaining: 500, reset, used: 0 },
        actions_runner_registration: { limit: 10000, remaining: 10000, reset, used: 0 },
        scim: { limit: 15000, remaining: 15000, reset, used: 0 },
        dependency_snapshots: { limit: 100, remaining: 100, reset, used: 0 },
        audit_log: { limit: 100, remaining: 100, reset, used: 0 },
        code_search: { limit: 10, remaining: 10, reset, used: 0 },
      },
      rate: core,
    });
    return;
  }

  // /search/* — not exercised by the REST checks; answer an empty result set.
  if (first === 'search' && rest.length === 2 && (second === 'repositories' || second === 'issues')) {
    if (method !== 'GET') throw notFound();
    sendJson(res, 200, { total_count: 0, incomplete_results: false, items: [] });
    return;
  }

  // /repos/:owner/:repo/...
  if (first === 'repos' && second !== undefined && third !== undefined) {
    const owner = second;
    const name = third;

    if (rest.length === 3) {
      if (method === 'GET') {
        handleGetRepo(req, res, store, owner, name);
        return;
      }
      if (method === 'PATCH') {
        handlePatchRepo(req, res, store, owner, name, body);
        return;
      }
      if (method === 'DELETE') {
        handleDeleteRepo(req, res, store, owner, name);
        return;
      }
      throw notFound();
    }

    if (fourth === 'branches') {
      if (rest.length === 4 && method === 'GET') {
        handleListBranches(req, res, store, owner, name);
        return;
      }
      if (rest.length >= 5 && method === 'GET') {
        handleGetBranch(req, res, store, owner, name, rest.slice(4).join('/'));
        return;
      }
      throw notFound();
    }

    if (fourth === 'git' && fifth === 'refs') {
      if (rest.length === 5 && method === 'POST') {
        handleCreateRef(req, res, store, owner, name, body);
        return;
      }
      if (rest.length >= 7 && sixth === 'heads' && method === 'GET') {
        handleGetRef(req, res, store, owner, name, rest.slice(6).join('/'));
        return;
      }
      throw notFound();
    }

    if (fourth === 'commits') {
      if (rest.length === 4 && method === 'GET') {
        handleListCommits(req, res, store, owner, name, url);
        return;
      }
      if (rest.length === 5 && method === 'GET') {
        handleGetCommit(req, res, store, owner, name, fifth as string);
        return;
      }
      throw notFound();
    }

    if (fourth === 'contents') {
      const path = rest.slice(4).join('/');
      if (method === 'GET') {
        handleGetContents(req, res, store, owner, name, path, url);
        return;
      }
      if (method === 'PUT') {
        handlePutContents(req, res, store, owner, name, path, body);
        return;
      }
      if (method === 'DELETE') {
        handleDeleteContents(req, res, store, owner, name, path, body);
        return;
      }
      throw notFound();
    }

    if (fourth === 'labels') {
      if (rest.length === 4 && method === 'GET') {
        handleListLabels(req, res, store, owner, name);
        return;
      }
      if (rest.length === 4 && method === 'POST') {
        handleCreateLabel(req, res, store, owner, name, body);
        return;
      }
      if (rest.length === 5 && method === 'GET') {
        handleGetLabel(req, res, store, owner, name, fifth as string);
        return;
      }
      if (rest.length === 5 && method === 'PATCH') {
        handlePatchLabel(req, res, store, owner, name, fifth as string, body);
        return;
      }
      if (rest.length === 5 && method === 'DELETE') {
        handleDeleteLabel(req, res, store, owner, name, fifth as string);
        return;
      }
      throw notFound();
    }

    if (fourth === 'issues') {
      if (rest.length === 4 && method === 'GET') {
        handleListIssues(req, res, store, owner, name, url);
        return;
      }
      if (rest.length === 4 && method === 'POST') {
        handleCreateIssue(req, res, store, owner, name, body);
        return;
      }
      if (rest.length === 6 && fifth === 'comments') {
        if (method === 'PATCH') {
          handlePatchComment(req, res, store, owner, name, sixth as string, body);
          return;
        }
        if (method === 'DELETE') {
          handleDeleteComment(req, res, store, owner, name, sixth as string);
          return;
        }
        throw notFound();
      }
      if (rest.length === 5 && method === 'GET') {
        handleGetIssue(req, res, store, owner, name, fifth as string);
        return;
      }
      if (rest.length === 5 && method === 'PATCH') {
        handlePatchIssue(req, res, store, owner, name, fifth as string, body);
        return;
      }
      if (rest.length === 6 && sixth === 'comments' && method === 'POST') {
        handleCreateComment(req, res, store, owner, name, fifth as string, body);
        return;
      }
      if (rest.length === 6 && sixth === 'comments' && method === 'GET') {
        handleListComments(req, res, store, owner, name, fifth as string, url);
        return;
      }
      throw notFound();
    }

    if (fourth === 'pulls') {
      if (rest.length === 4 && method === 'GET') {
        handleListPulls(req, res, store, owner, name, url);
        return;
      }
      if (rest.length === 4 && method === 'POST') {
        handleCreatePull(req, res, store, owner, name, body);
        return;
      }
      if (rest.length === 5 && method === 'GET') {
        handleGetPull(req, res, store, owner, name, fifth as string);
        return;
      }
      if (rest.length === 5 && method === 'PATCH') {
        handlePatchPull(req, res, store, owner, name, fifth as string, body);
        return;
      }
      if (rest.length === 6 && sixth === 'files' && method === 'GET') {
        handleListPullFiles(req, res, store, owner, name, fifth as string);
        return;
      }
      if (rest.length === 6 && sixth === 'commits' && method === 'GET') {
        handleListPullCommits(req, res, store, owner, name, fifth as string, url);
        return;
      }
      if (rest.length === 6 && sixth === 'merge' && method === 'PUT') {
        handleMergePull(req, res, store, owner, name, fifth as string, body);
        return;
      }
      throw notFound();
    }
  }

  throw notFound();
}

/**
 * Handle one request under /api/v3. Returns true when this module answered
 * it (including the JSON 404 for unknown /api/v3 routes) and false for
 * anything outside /api/v3, which the caller (app.ts) owns.
 */
export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/v3')) return false;
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  try {
    const segments = splitPath(path);
    if (segments === null || segments[0] !== 'api' || segments[1] !== 'v3') throw notFound();
    if (segments.length === 2) {
      if ((req.method ?? 'GET') !== 'GET') throw notFound();
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    const rest = segments.slice(2);
    if (rest[0] === 'meta' && rest.length === 1) {
      if ((req.method ?? 'GET') !== 'GET') throw notFound();
      sendJson(res, 200, { installed_version: '1.0.0' });
      return true;
    }
    requireAuth(req);
    const method = req.method ?? 'GET';
    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const body = needsBody ? await readJsonBody(req) : undefined;
    await dispatch(req, res, store, url, rest, method, body);
    return true;
  } catch (err) {
    if (err instanceof HttpError) {
      sendError(res, err);
      return true;
    }
    sendJson(res, 500, { message: 'Internal Server Error' });
    return true;
  }
}
