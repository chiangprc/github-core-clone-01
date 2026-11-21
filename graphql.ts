// graphql.ts — GitHub GraphQL v4 (POST /api/graphql) for the github-core-clone-01 entry.
//
// A small hand-rolled executor for exactly the documents the conformance suite sends
// (env/src/checks-graphql.ts): viewer/repository reads, issue and pull-request reads,
// the __type introspection probes gh uses, node(id:), cursor pagination, operation
// batching, and the five mutations (createIssue, closeIssue, createPullRequest,
// mergePullRequest, addComment). It is NOT a general GraphQL engine: unknown fields
// are reported as GraphQL errors (HTTP 200 with an `errors` array), everything else
// resolves against the shared store in ./store.ts.
//
// Auth: the same bearer token as REST (MAKEFUN_SHOP_TOKEN). No token header -> 401.
// Determinism: no Date.now()/new Date()/Math.random() in served state; created
// timestamps use trialNow() from ./store.ts (MAKEFUN_TRIAL_NOW, fallback
// '2026-11-21T06:30:00.000Z'). Global ids are base64 of a typed key, stable and
// opaque (never the plain database id or issue number).

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as storeModule from './store.ts';
import type { Store } from './store.ts';
import { parseCommit, parseTree } from './objects.ts';
import { viewerUser } from './rest.ts';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The trial clock: store.ts's trialNow() when present, else the env/fallback. */
function nowIso(): string {
  const mod = storeModule as unknown as Record<string, unknown>;
  const fn = mod.trialNow;
  if (typeof fn === 'function') {
    const value = (fn as () => unknown)();
    if (typeof value === 'string' && value !== '') return value;
  }
  if (typeof fn === 'string' && fn !== '') return fn;
  const env = process.env.MAKEFUN_TRIAL_NOW;
  return env !== undefined && env !== '' ? env : '2026-11-21T06:30:00.000Z';
}

/** FNV-1a 32-bit, for stable numeric ids when the store carries none. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The token owner's login: rest.ts's viewerUser() (the scenario's viewer, re-derived
 * from the contest's fixed seed), falling back to the store's owner when that is
 * unavailable. */
function viewerLogin(store: Store): string {
  try {
    const login = viewerUser().login;
    if (typeof login === 'string' && login !== '') return login;
  } catch {
    // fall through to the store-based lookup below
  }
  const s = store as unknown as Record<string, unknown>;
  if (typeof s.viewerLogin === 'string' && s.viewerLogin !== '') return s.viewerLogin;
  const viewer = s.viewer;
  if (isRecord(viewer) && typeof viewer.login === 'string' && viewer.login !== '') return viewer.login;
  if (typeof s.owner === 'string' && s.owner !== '') return s.owner;
  const repos = s.repos;
  if (repos instanceof Map) {
    for (const repo of repos.values()) {
      if (isRecord(repo) && typeof repo.owner === 'string' && repo.owner !== '') return repo.owner;
    }
  }
  return 'viewer';
}

/** The repository's numeric id: the store's own id when present, else the same
 * FNV-1a hash rest.ts uses — (hash32(`${owner}/${name}`) % 2147483646) + 1 — so
 * GraphQL databaseId byte-matches REST's repo id. */
function repoNumericId(repo: Record<string, unknown>): number {
  const id = repo.id;
  if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
  if (typeof id === 'string' && /^\d+$/.test(id) && Number(id) > 0) return Number(id);
  const fullName = typeof repo.full_name === 'string' ? repo.full_name : `${String(repo.owner ?? '')}/${String(repo.name ?? '')}`;
  return (fnv1a(fullName) % 2_147_483_646) + 1;
}

/** Opaque, stable global (Relay) ids: base64 of `kind:key`. */
function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function ungid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { kind: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
  });
  res.end(text);
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return token === expected;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

// ---------------------------------------------------------------------------
// Store access (defensive: the store's exact shapes are the sibling agent's;
// these helpers read the interface the task states, with fallbacks).
// ---------------------------------------------------------------------------

type RepoRec = Record<string, unknown>;
type IssueRec = Record<string, unknown>;
type PullRec = Record<string, unknown>;

function getRepo(store: Store, owner: string, name: string): RepoRec | null {
  const s = store as unknown as Record<string, unknown>;
  const getter = s.getRepo;
  if (typeof getter === 'function') {
    const found = (getter as (o: string, n: string) => unknown).call(store, owner, name);
    return isRecord(found) ? found : null;
  }
  const repos = s.repos;
  if (repos instanceof Map) {
    const direct = repos.get(`${owner}/${name}`);
    if (isRecord(direct)) return direct;
    for (const repo of repos.values()) {
      if (isRecord(repo) && repo.owner === owner && repo.name === name) return repo;
    }
  }
  return null;
}

function issueList(repo: RepoRec): IssueRec[] {
  const issues = repo.issues;
  if (issues instanceof Map) {
    const out: IssueRec[] = [];
    for (const issue of issues.values()) if (isRecord(issue)) out.push(issue);
    return out.sort((a, b) => Number(a.number ?? 0) - Number(b.number ?? 0));
  }
  if (Array.isArray(issues)) {
    return issues.filter(isRecord).sort((a, b) => Number(a.number ?? 0) - Number(b.number ?? 0));
  }
  return [];
}

function pullList(repo: RepoRec): PullRec[] {
  const pulls = repo.pulls;
  if (pulls instanceof Map) {
    const out: PullRec[] = [];
    for (const pull of pulls.values()) if (isRecord(pull)) out.push(pull);
    return out.sort((a, b) => Number(a.number ?? 0) - Number(b.number ?? 0));
  }
  if (Array.isArray(pulls)) {
    return pulls.filter(isRecord).sort((a, b) => Number(a.number ?? 0) - Number(b.number ?? 0));
  }
  return [];
}

function issueStateOf(issue: IssueRec): string {
  return typeof issue.state === 'string' ? issue.state.toLowerCase() : 'open';
}

function nextIssueNumber(repo: RepoRec): number {
  const counter = repo.nextIssue;
  if (typeof counter === 'number' && Number.isInteger(counter) && counter > 0) return counter;
  let max = 0;
  for (const issue of issueList(repo)) max = Math.max(max, Number(issue.number ?? 0));
  return max + 1;
}

function nextPullNumber(repo: RepoRec): number {
  const counter = repo.nextPull;
  if (typeof counter === 'number' && Number.isInteger(counter) && counter > 0) return counter;
  let max = 0;
  for (const pull of pullList(repo)) max = Math.max(max, Number(pull.number ?? 0));
  return max + 1;
}

function createIssueInStore(store: Store, repo: RepoRec, title: string, body: string): IssueRec {
  const viewer = viewerLogin(store);
  const number = nextIssueNumber(repo);
  if (typeof repo.nextIssue === 'number') repo.nextIssue = number + 1;
  const now = nowIso();
  const issue: IssueRec = {
    number,
    title,
    body: body ?? '',
    state: 'open',
    labels: [],
    assignees: [],
    user: { login: viewer },
    created_at: now,
    updated_at: now,
    comments: [],
  };
  const issues = repo.issues;
  if (issues instanceof Map) issues.set(number, issue);
  else if (Array.isArray(issues)) issues.push(issue);
  else repo.issues = new Map([[number, issue]]);
  return issue;
}

function createPullInStore(store: Store, repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
  const viewer = viewerLogin(store);
  const number = nextPullNumber(repo);
  if (typeof repo.nextPull === 'number') repo.nextPull = number + 1;
  const now = nowIso();
  const pull: PullRec = {
    number,
    title,
    body: body ?? '',
    state: 'open',
    head: { ref: headRef, sha: refShaOf(repo, headRef) ?? '' },
    base: { ref: baseRef, sha: refShaOf(repo, baseRef) ?? '' },
    user: { login: viewer },
    created_at: now,
    updated_at: now,
    merged_at: null,
    mergeable: true,
  };
  const pulls = repo.pulls;
  if (pulls instanceof Map) pulls.set(number, pull);
  else if (Array.isArray(pulls)) pulls.push(pull);
  else repo.pulls = new Map([[number, pull]]);
  return pull;
}

function mapGet(container: unknown, key: string): unknown {
  if (container instanceof Map) return container.get(key);
  if (isRecord(container)) return container[key];
  return undefined;
}

function refShaOf(repo: RepoRec, branch: string): string | null {
  const refs = repo.refs;
  for (const key of [`refs/heads/${branch}`, `heads/${branch}`, branch]) {
    const value = mapGet(refs, key);
    if (typeof value === 'string' && value !== '') return value;
    if (isRecord(value) && typeof value.sha === 'string' && value.sha !== '') return value.sha;
    if (isRecord(value) && typeof value.oid === 'string' && value.oid !== '') return value.oid;
  }
  return null;
}

/** One stored git object: {type, data} with raw body bytes (see objects.ts). */
function objectEntry(repo: RepoRec, sha: string): { type: string; data: Buffer } | null {
  const found = mapGet(repo.objects, sha);
  if (!isRecord(found)) return null;
  if (typeof found.type !== 'string') return null;
  const data = found.data;
  if (Buffer.isBuffer(data)) return { type: found.type, data };
  if (data instanceof Uint8Array) return { type: found.type, data: Buffer.from(data) };
  return null;
}

/** The tree a commit points at, via objects.ts's commit parser. */
function commitTreeSha(repo: RepoRec, commitSha: string): string | null {
  try {
    const object = objectEntry(repo, commitSha);
    if (object === null || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  } catch {
    return null;
  }
}

/** All blob paths of a tree, recursively, via objects.ts's tree parser. */
function treePaths(repo: RepoRec, treeSha: string, prefix: string, out: Map<string, string>, depth: number): void {
  if (depth > 8) return;
  try {
    const object = objectEntry(repo, treeSha);
    if (object === null || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') treePaths(repo, entry.sha, path, out, depth + 1);
      else out.set(path, entry.sha);
    }
  } catch {
    return;
  }
}

/** Paths added or changed on the head branch versus the base branch, sorted. */
function changedFiles(repo: RepoRec, pull: PullRec): string[] {
  const head = isRecord(pull.head) ? pull.head : {};
  const base = isRecord(pull.base) ? pull.base : {};
  const headRef = typeof head.ref === 'string' ? head.ref : '';
  const baseRef = typeof base.ref === 'string' ? base.ref : '';
  const headSha = (typeof head.sha === 'string' && head.sha !== '' ? head.sha : refShaOf(repo, headRef));
  const baseSha = (typeof base.sha === 'string' && base.sha !== '' ? base.sha : refShaOf(repo, baseRef));
  if (headSha === null || headSha === '') return [];
  const headTree = commitTreeSha(repo, headSha);
  if (headTree === null) return [];
  const headPaths = new Map<string, string>();
  treePaths(repo, headTree, '', headPaths, 0);
  const basePaths = new Map<string, string>();
  if (baseSha !== null && baseSha !== '') {
    const baseTree = commitTreeSha(repo, baseSha);
    if (baseTree !== null) treePaths(repo, baseTree, '', basePaths, 0);
  }
  const changed: string[] = [];
  for (const [path, oid] of headPaths) {
    if (basePaths.get(path) !== oid) changed.push(path);
  }
  return changed.sort();
}

// ---------------------------------------------------------------------------
// GraphQL document parser (the subset the suite sends)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

type SelectionNode =
  | { kind: 'Field'; name: string; alias: string | null; args: Array<{ name: string; value: ValueNode }>; selections: SelectionNode[] | null }
  | { kind: 'InlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'FragmentSpread'; name: string };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selections: SelectionNode[] }>;
}

interface Token {
  kind: string;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: c, value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1] ?? '';
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u' && j + 5 < src.length) {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
        } else {
          out += src[j] ?? '';
          j += 1;
        }
      }
      tokens.push({ kind: 'String', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] ?? '')) j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] ?? '')) j += 1;
      }
      tokens.push({ kind: isFloat ? 'Float' : 'Int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j] ?? '')) j += 1;
      tokens.push({ kind: 'Name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: 'EOF', value: '' };
  }

  private next(): Token {
    const token = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private eat(kind: string): Token | null {
    if (this.peek().kind === kind) return this.next();
    return null;
  }

  private expect(kind: string): Token {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`Expected ${kind} but found ${token.kind} ${JSON.stringify(token.value)}`);
    return token;
  }

  private expectName(what = 'a name'): string {
    const token = this.expect('Name');
    if (token.value === '') throw new Error(`Expected ${what}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selections: SelectionNode[] }>();
    while (this.peek().kind !== 'EOF') {
      const token = this.peek();
      if (token.kind === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'Name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        const kind = token.value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'Name') name = this.next().value;
        if (this.peek().kind === '(') this.parseVariableDefinitions();
        operations.push({ kind, name, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'Name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('a fragment name');
        this.expectName('the "on" keyword');
        const typeCondition = this.expectName('a fragment type');
        fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Unexpected token ${token.kind} ${JSON.stringify(token.value)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  /** Skip `($name: Type, ...)`; only the names matter to the executor. */
  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek().kind !== ')') {
      this.expect('$');
      this.expectName('a variable name');
      this.expect(':');
      this.parseType();
      if (this.peek().kind === '=') {
        this.next();
        this.parseValue();
      }
      if (this.peek().kind === 'Name') {
        // A directive name after a default; directives are not used by the suite.
        this.next();
        if (this.peek().kind === '(') this.parseArgumentsRaw();
      }
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.eat('[') !== null) {
      this.parseType();
      this.expect(']');
    } else {
      this.expectName('a type name');
    }
    this.eat('!');
  }

  private parseArgumentsRaw(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'EOF') throw new Error('Unterminated arguments');
      if (token.kind === '(' || token.kind === '[' || token.kind === '{') depth += 1;
      if (token.kind === ')' || token.kind === ']' || token.kind === '}') depth -= 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === 'EOF') throw new Error('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.eat('...') !== null) {
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('a fragment type');
        return { kind: 'InlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'Name') {
        return { kind: 'FragmentSpread', name: this.next().value };
      }
      return { kind: 'InlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let name = first;
    let alias: string | null = null;
    if (this.eat(':') !== null) {
      alias = first;
      name = this.expectName('a field name');
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === '(') {
      this.expect('(');
      while (this.peek().kind !== ')') {
        const argName = this.expectName('an argument name');
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    if (this.peek().kind === '@') {
      // Directives are not used by the suite; skip `@name` and its arguments.
      this.next();
      this.expectName('a directive name');
      if (this.peek().kind === '(') this.parseArgumentsRaw();
    }
    const selections = this.peek().kind === '{' ? this.parseSelectionSet() : null;
    return { kind: 'Field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === '$') {
      this.next();
      return { kind: 'Variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'String') {
      this.next();
      return { kind: 'String', value: token.value };
    }
    if (token.kind === 'Int') {
      this.next();
      return { kind: 'Int', value: Number(token.value) };
    }
    if (token.kind === 'Float') {
      this.next();
      return { kind: 'Float', value: Number(token.value) };
    }
    if (token.kind === 'Name') {
      this.next();
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    if (token.kind === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (this.peek().kind !== ']') {
        if (this.peek().kind === 'EOF') throw new Error('Unterminated list value');
        values.push(this.parseValue());
      }
      this.expect(']');
      return { kind: 'List', values };
    }
    if (token.kind === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek().kind !== '}') {
        if (this.peek().kind === 'EOF') throw new Error('Unterminated object value');
        const name = this.expectName('an object field name');
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'Object', fields };
    }
    throw new Error(`Unexpected value token ${token.kind} ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------
// Introspection tables (the fields gh feature-detects, plus the enums it probes)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'labels', 'assignees', 'comments', 'createdAt', 'updatedAt', 'url', 'repository', 'closed', 'locked', 'milestone'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews', 'labels', 'assignees', 'isDraft', 'mergedAt', 'closedAt', 'headRef', 'baseRef', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'object', 'ref', 'refs', 'labels', 'milestones', 'watchers', 'stargazerCount', 'forkCount'],
  User: ['id', 'login', 'name', 'avatarUrl', 'url'],
  Actor: ['id', 'login', 'avatarUrl', 'url'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'totalCount', 'pageInfo', 'edges'],
  PullRequestConnection: ['nodes', 'totalCount', 'pageInfo', 'edges'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'prefix', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'totalCount', 'pageInfo'],
  IssueCommentConnection: ['nodes', 'totalCount', 'pageInfo'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
};

const TYPE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  viewer: string;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

type Resolver = (parent: Record<string, unknown>, args: Record<string, unknown>, ctx: ExecContext) => unknown;

function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'String':
    case 'Int':
    case 'Float':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((value) => valueFromAst(value, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(args: Array<{ name: string; value: ValueNode }>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = valueFromAst(arg.value, variables);
  return out;
}

function issueNode(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return { __typename: 'PullRequest', repo, pull };
}

function userNode(login: string): Record<string, unknown> {
  return { __typename: 'User', login };
}

function repoNode(repo: RepoRec): Record<string, unknown> {
  return { __typename: 'Repository', repo };
}

function decodeIssueId(ctx: ExecContext, id: unknown): { repo: RepoRec; issue: IssueRec } | null {
  if (typeof id !== 'string') return null;
  const decoded = ungid(id);
  if (decoded === null || decoded.kind !== 'I') return null;
  const match = /^(.+)\/([^/]+):(\d+)$/.exec(decoded.key);
  if (match === null) return null;
  const repo = getRepo(ctx.store, match[1] ?? '', match[2] ?? '');
  if (repo === null) return null;
  const issue = issueList(repo).find((entry) => Number(entry.number) === Number(match[3]));
  return issue === undefined ? null : { repo, issue };
}

function decodePullId(ctx: ExecContext, id: unknown): { repo: RepoRec; pull: PullRec } | null {
  if (typeof id !== 'string') return null;
  const decoded = ungid(id);
  if (decoded === null || decoded.kind !== 'P') return null;
  const match = /^(.+)\/([^/]+):(\d+)$/.exec(decoded.key);
  if (match === null) return null;
  const repo = getRepo(ctx.store, match[1] ?? '', match[2] ?? '');
  if (repo === null) return null;
  const pull = pullList(repo).find((entry) => Number(entry.number) === Number(match[3]));
  return pull === undefined ? null : { repo, pull };
}

function decodeRepoId(ctx: ExecContext, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const decoded = ungid(id);
  if (decoded === null || decoded.kind !== 'R') return null;
  const slash = decoded.key.lastIndexOf('/');
  if (slash <= 0) return null;
  return getRepo(ctx.store, decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
}

function issueConnection(repo: RepoRec, args: Record<string, unknown>): Record<string, unknown> {
  let list = issueList(repo);
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issueStateOf(issue)));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  list = [...list].sort((a, b) => direction * (Number(a.number ?? 0) - Number(b.number ?? 0)));
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  if (after !== null) list = direction < 0 ? list.filter((issue) => Number(issue.number ?? 0) < after) : list.filter((issue) => Number(issue.number ?? 0) > after);
  const total = list.length;
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : undefined;
  const page = first === undefined ? list : list.slice(0, first);
  const hasNext = first !== undefined && list.length > first;
  const endCursor = page.length > 0 ? encodeCursor(Number(page[page.length - 1]?.number ?? 0)) : null;
  const startCursor = page.length > 0 ? encodeCursor(Number(page[0]?.number ?? 0)) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    totalCount: total,
    pageInfo: { __typename: 'PageInfo', hasNextPage: hasNext, hasPreviousPage: false, startCursor, endCursor },
  };
}

function pullConnection(repo: RepoRec, args: Record<string, unknown>): Record<string, unknown> {
  const list = [...pullList(repo)].sort((a, b) => Number(b.number ?? 0) - Number(a.number ?? 0));
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : undefined;
  const page = first === undefined ? list : list.slice(0, first);
  const hasNext = first !== undefined && list.length > first;
  const endCursor = page.length > 0 ? encodeCursor(Number(page[page.length - 1]?.number ?? 0)) : null;
  const startCursor = page.length > 0 ? encodeCursor(Number(page[0]?.number ?? 0)) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullNode(repo, pull)),
    totalCount: list.length,
    pageInfo: { __typename: 'PageInfo', hasNextPage: hasNext, hasPreviousPage: false, startCursor, endCursor },
  };
}

function commentList(issue: IssueRec): Array<Record<string, unknown>> {
  const comments = issue.comments;
  if (!Array.isArray(comments)) return [];
  return comments.filter(isRecord);
}

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: (_parent, _args, ctx) => userNode(ctx.viewer),
    repository: (_parent, args, ctx) => {
      if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
      const repo = getRepo(ctx.store, args.owner, args.name);
      return repo === null ? null : repoNode(repo);
    },
    node: (_parent, args, ctx) => {
      if (typeof args.id !== 'string') return null;
      const decoded = ungid(args.id);
      if (decoded === null) return null;
      if (decoded.kind === 'R') {
        const slash = decoded.key.lastIndexOf('/');
        if (slash <= 0) return null;
        const repo = getRepo(ctx.store, decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
        return repo === null ? null : repoNode(repo);
      }
      if (decoded.kind === 'I') {
        const found = decodeIssueId(ctx, args.id);
        return found === null ? null : issueNode(found.repo, found.issue);
      }
      if (decoded.kind === 'P') {
        const found = decodePullId(ctx, args.id);
        return found === null ? null : pullNode(found.repo, found.pull);
      }
      if (decoded.kind === 'U') return userNode(decoded.key);
      return null;
    },
    __type: (_parent, args, _ctx) => {
      if (typeof args.name !== 'string') return null;
      const fields = TYPE_FIELDS[args.name];
      const enums = TYPE_ENUMS[args.name];
      if (fields === undefined && enums === undefined) return null;
      return {
        __typename: '__Type',
        name: args.name,
        kind: enums !== undefined ? 'ENUM' : 'OBJECT',
        fields: (fields ?? []).map((name) => ({ __typename: '__Field', name })),
        enumValues: (enums ?? []).map((name) => ({ __typename: '__EnumValue', name })),
      };
    },
  },
  Repository: {
    id: (parent) => {
      const repo = parent.repo as RepoRec;
      return gid('R', `${String(repo.owner ?? '')}/${String(repo.name ?? '')}`);
    },
    databaseId: (parent) => repoNumericId(parent.repo as RepoRec),
    name: (parent) => String((parent.repo as RepoRec).name ?? ''),
    nameWithOwner: (parent) => {
      const repo = parent.repo as RepoRec;
      return `${String(repo.owner ?? '')}/${String(repo.name ?? '')}`;
    },
    owner: (parent) => userNode(String((parent.repo as RepoRec).owner ?? '')),
    description: (parent) => {
      const value = (parent.repo as RepoRec).description;
      return typeof value === 'string' ? value : null;
    },
    defaultBranchRef: (parent) => ({ __typename: 'Ref', name: String((parent.repo as RepoRec).default_branch ?? 'main') }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args) => {
      const repo = parent.repo as RepoRec;
      if (typeof args.number !== 'number') return null;
      const issue = issueList(repo).find((entry) => Number(entry.number) === args.number);
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (parent, args) => issueConnection(parent.repo as RepoRec, args),
    pullRequests: (parent, args) => pullConnection(parent.repo as RepoRec, args),
    pullRequest: (parent, args) => {
      const repo = parent.repo as RepoRec;
      if (typeof args.number !== 'number') return null;
      const pull = pullList(repo).find((entry) => Number(entry.number) === args.number);
      return pull === undefined ? null : pullNode(repo, pull);
    },
    object: () => null,
  },
  Issue: {
    id: (parent) => {
      const repo = parent.repo as RepoRec;
      const issue = parent.issue as IssueRec;
      return gid('I', `${String(repo.owner ?? '')}/${String(repo.name ?? '')}:${String(issue.number ?? '')}`);
    },
    number: (parent) => Number((parent.issue as IssueRec).number ?? 0),
    title: (parent) => String((parent.issue as IssueRec).title ?? ''),
    body: (parent) => {
      const value = (parent.issue as IssueRec).body;
      return typeof value === 'string' ? value : '';
    },
    state: (parent) => (issueStateOf(parent.issue as IssueRec) === 'closed' ? 'CLOSED' : 'OPEN'),
    author: (parent) => {
      const issue = parent.issue as IssueRec;
      const login = isRecord(issue.user) && typeof issue.user.login === 'string' ? issue.user.login : '';
      return userNode(login);
    },
    labels: (parent) => {
      const issue = parent.issue as IssueRec;
      const labels = Array.isArray(issue.labels) ? issue.labels : [];
      const nodes = labels.map((label) => ({ __typename: 'Label', name: typeof label === 'string' ? label : String(isRecord(label) && typeof label.name === 'string' ? label.name : label) }));
      return { __typename: 'LabelConnection', nodes, totalCount: nodes.length, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    },
    comments: (parent) => {
      const repo = parent.repo as RepoRec;
      const issue = parent.issue as IssueRec;
      const nodes = commentList(issue).map((comment, index) => ({
        __typename: 'IssueComment',
        repo,
        issue,
        comment,
        index,
      }));
      return { __typename: 'IssueCommentConnection', nodes, totalCount: nodes.length, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    },
    createdAt: (parent) => String((parent.issue as IssueRec).created_at ?? ''),
    updatedAt: (parent) => String((parent.issue as IssueRec).updated_at ?? ''),
  },
  PullRequest: {
    id: (parent) => {
      const repo = parent.repo as RepoRec;
      const pull = parent.pull as PullRec;
      return gid('P', `${String(repo.owner ?? '')}/${String(repo.name ?? '')}:${String(pull.number ?? '')}`);
    },
    number: (parent) => Number((parent.pull as PullRec).number ?? 0),
    title: (parent) => String((parent.pull as PullRec).title ?? ''),
    body: (parent) => {
      const value = (parent.pull as PullRec).body;
      return typeof value === 'string' ? value : '';
    },
    state: (parent) => {
      const pull = parent.pull as PullRec;
      if (pull.merged_at !== null && pull.merged_at !== undefined && pull.merged_at !== '') return 'MERGED';
      return String(pull.state ?? 'open').toLowerCase() === 'open' ? 'OPEN' : 'CLOSED';
    },
    headRefName: (parent) => {
      const head = (parent.pull as PullRec).head;
      return isRecord(head) && typeof head.ref === 'string' ? head.ref : '';
    },
    baseRefName: (parent) => {
      const base = (parent.pull as PullRec).base;
      return isRecord(base) && typeof base.ref === 'string' ? base.ref : '';
    },
    mergeable: (parent) => {
      const value = (parent.pull as PullRec).mergeable;
      if (value === true) return 'MERGEABLE';
      if (value === false) return 'CONFLICTING';
      return 'UNKNOWN';
    },
    merged: (parent) => {
      const pull = parent.pull as PullRec;
      return pull.merged_at !== null && pull.merged_at !== undefined && pull.merged_at !== '' ? true : pull.merged === true;
    },
    files: (parent, args) => {
      const repo = parent.repo as RepoRec;
      const pull = parent.pull as PullRec;
      const paths = changedFiles(repo, pull);
      const first = typeof args.first === 'number' && args.first >= 0 ? args.first : undefined;
      const page = first === undefined ? paths : paths.slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: page.map((path) => ({ __typename: 'PullRequestChangedFile', path })),
        totalCount: paths.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: first !== undefined && paths.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    },
    author: (parent, _args, ctx) => {
      const pull = parent.pull as PullRec;
      const login = isRecord(pull.user) && typeof pull.user.login === 'string' ? pull.user.login : ctx.viewer;
      return userNode(login);
    },
    createdAt: (parent) => String((parent.pull as PullRec).created_at ?? ''),
    updatedAt: (parent) => String((parent.pull as PullRec).updated_at ?? ''),
  },
  User: {
    id: (parent) => gid('U', String(parent.login ?? '')),
    login: (parent) => String(parent.login ?? ''),
  },
  Actor: {
    id: (parent) => gid('U', String(parent.login ?? '')),
    login: (parent) => String(parent.login ?? ''),
  },
  IssueConnection: {
    nodes: (parent) => (Array.isArray(parent.nodes) ? parent.nodes : []),
    totalCount: (parent) => Number(parent.totalCount ?? 0),
    pageInfo: (parent) => parent.pageInfo ?? null,
  },
  PullRequestConnection: {
    nodes: (parent) => (Array.isArray(parent.nodes) ? parent.nodes : []),
    totalCount: (parent) => Number(parent.totalCount ?? 0),
    pageInfo: (parent) => parent.pageInfo ?? null,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => (Array.isArray(parent.nodes) ? parent.nodes : []),
    totalCount: (parent) => Number(parent.totalCount ?? 0),
    pageInfo: (parent) => parent.pageInfo ?? null,
  },
  LabelConnection: {
    nodes: (parent) => (Array.isArray(parent.nodes) ? parent.nodes : []),
    totalCount: (parent) => Number(parent.totalCount ?? 0),
    pageInfo: (parent) => parent.pageInfo ?? null,
  },
  IssueCommentConnection: {
    nodes: (parent) => (Array.isArray(parent.nodes) ? parent.nodes : []),
    totalCount: (parent) => Number(parent.totalCount ?? 0),
    pageInfo: (parent) => parent.pageInfo ?? null,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage === true,
    hasPreviousPage: (parent) => parent.hasPreviousPage === true,
    startCursor: (parent) => (typeof parent.startCursor === 'string' ? parent.startCursor : null),
    endCursor: (parent) => (typeof parent.endCursor === 'string' ? parent.endCursor : null),
  },
  Ref: {
    name: (parent) => String(parent.name ?? ''),
  },
  Label: {
    name: (parent) => String(parent.name ?? ''),
  },
  IssueComment: {
    id: (parent) => {
      const repo = parent.repo as RepoRec;
      const issue = parent.issue as IssueRec;
      const comment = parent.comment as IssueRec;
      const numeric = typeof comment.id === 'number' ? comment.id : Number(parent.index ?? 0) + 1;
      return gid('C', `${String(repo.owner ?? '')}/${String(repo.name ?? '')}:${String(issue.number ?? '')}:${numeric}`);
    },
    body: (parent) => String((parent.comment as IssueRec).body ?? ''),
    author: (parent, _args, ctx) => {
      const comment = parent.comment as IssueRec;
      const login = isRecord(comment.user) && typeof comment.user.login === 'string' ? comment.user.login : ctx.viewer;
      return userNode(login);
    },
    createdAt: (parent) => String((parent.comment as IssueRec).created_at ?? ''),
    updatedAt: (parent) => String((parent.comment as IssueRec).updated_at ?? ''),
  },
  __Type: {
    name: (parent) => String(parent.name ?? ''),
    kind: (parent) => String(parent.kind ?? 'OBJECT'),
    fields: (parent) => (Array.isArray(parent.fields) ? parent.fields : []),
    enumValues: (parent) => (Array.isArray(parent.enumValues) ? parent.enumValues : []),
  },
  __Field: {
    name: (parent) => String(parent.name ?? ''),
  },
  __EnumValue: {
    name: (parent) => String(parent.name ?? ''),
  },
  PullRequestChangedFile: {
    path: (parent) => String(parent.path ?? ''),
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = decodeRepoId(ctx, input.repositoryId);
      if (repo === null) throw new Error('repository not found for createIssue');
      if (typeof input.title !== 'string' || input.title === '') throw new Error('createIssue needs a title');
      const issue = createIssueInStore(ctx.store, repo, input.title, typeof input.body === 'string' ? input.body : '');
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = decodeIssueId(ctx, input.issueId);
      if (found === null) throw new Error('issue not found for closeIssue');
      found.issue.state = 'closed';
      found.issue.updated_at = nowIso();
      return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = decodeRepoId(ctx, input.repositoryId);
      if (repo === null) throw new Error('repository not found for createPullRequest');
      if (typeof input.headRefName !== 'string' || typeof input.baseRefName !== 'string') {
        throw new Error('createPullRequest needs headRefName and baseRefName');
      }
      const pull = createPullInStore(ctx.store, repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', input.headRefName, input.baseRefName);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = decodePullId(ctx, input.pullRequestId);
      if (found === null) throw new Error('pull request not found for mergePullRequest');
      found.pull.merged_at = nowIso();
      found.pull.state = 'closed';
      found.pull.updated_at = nowIso();
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
    },
    addComment: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = decodeIssueId(ctx, input.subjectId);
      if (found === null) throw new Error('subject not found for addComment');
      if (typeof input.body !== 'string' || input.body === '') throw new Error('addComment needs a body');
      const comments = Array.isArray(found.issue.comments) ? found.issue.comments : [];
      found.issue.comments = comments;
      const numericId = typeof found.repo.nextComment === 'number' && found.repo.nextComment > 0 ? found.repo.nextComment : comments.length + 1;
      if (typeof found.repo.nextComment === 'number') found.repo.nextComment = numericId + 1;
      const now = nowIso();
      const comment: IssueRec = {
        id: numericId,
        body: input.body,
        user: { login: ctx.viewer },
        created_at: now,
        updated_at: now,
      };
      comments.push(comment);
      found.issue.updated_at = now;
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', repo: found.repo, issue: found.issue, comment, index: comments.length - 1 },
          cursor: encodeCursor(numericId),
        },
      };
    },
  },
  CreateIssuePayload: {
    issue: (parent) => parent.issue ?? null,
  },
  CloseIssuePayload: {
    issue: (parent) => parent.issue ?? null,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest ?? null,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest ?? null,
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent.commentEdge ?? null,
  },
  IssueCommentEdge: {
    node: (parent) => parent.node ?? null,
    cursor: (parent) => (typeof parent.cursor === 'string' ? parent.cursor : null),
  },
};

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__typename') continue;
      out[key] = sanitize(entry);
    }
    return out;
  }
  return value;
}

function completeValue(
  value: unknown,
  selections: SelectionNode[] | null,
  doc: DocumentNode,
  ctx: ExecContext,
  variables: Record<string, unknown>,
  path: Array<string | number>,
): unknown {
  if (value === null || value === undefined) return null;
  if (selections === null) return sanitize(value);
  if (Array.isArray(value)) {
    return value.map((entry) => completeValue(entry, selections, doc, ctx, variables, path));
  }
  if (isRecord(value)) {
    const typeName = typeof value.__typename === 'string' ? value.__typename : 'Query';
    return executeSelections(selections, value, typeName, doc, ctx, variables, path);
  }
  return value;
}

function executeSelections(
  selections: SelectionNode[],
  parent: Record<string, unknown>,
  parentType: string,
  doc: DocumentNode,
  ctx: ExecContext,
  variables: Record<string, unknown>,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      const key = selection.alias ?? selection.name;
      const fieldPath = [...path, key];
      const table = RESOLVERS[parentType];
      const resolver = table?.[selection.name];
      if (resolver === undefined) {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".`, path: fieldPath });
        out[key] = null;
        continue;
      }
      let value: unknown;
      try {
        value = resolver(parent, resolveArgs(selection.args, variables), ctx);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
        out[key] = null;
        continue;
      }
      out[key] = completeValue(value, selection.selections, doc, ctx, variables, fieldPath);
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      const typeName = typeof parent.__typename === 'string' ? parent.__typename : parentType;
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelections(selection.selections, parent, parentType, doc, ctx, variables, path));
      }
      continue;
    }
    const fragment = doc.fragments.get(selection.name);
    if (fragment === undefined) {
      ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
      continue;
    }
    const typeName = typeof parent.__typename === 'string' ? parent.__typename : parentType;
    if (fragment.typeCondition === null || fragment.typeCondition === typeName) {
      Object.assign(out, executeSelections(fragment.selections, parent, parentType, doc, ctx, variables, path));
    }
  }
  return out;
}

interface OperationInput {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function runOperation(input: unknown, ctx: ExecContext): Record<string, unknown> {
  if (!isRecord(input) || typeof input.query !== 'string' || input.query.trim() === '') {
    return { data: null, errors: [{ message: 'a GraphQL operation needs a query string' }] };
  }
  const variables = isRecord(input.variables) ? (input.variables as Record<string, unknown>) : {};
  let doc: DocumentNode;
  try {
    doc = new Parser(input.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'the document holds no operation' }] };
  }
  let operation = doc.operations[0] as OperationNode;
  if (typeof input.operationName === 'string' && input.operationName !== '') {
    const named = doc.operations.find((entry) => entry.name === input.operationName);
    if (named !== undefined) operation = named;
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: Record<string, unknown> = { __typename: rootType };
  const errorsBefore = ctx.errors.length;
  const data = executeSelections(operation.selections, root, rootType, doc, ctx, variables, []);
  const freshErrors = ctx.errors.slice(errorsBefore);
  const body: Record<string, unknown> = { data };
  if (freshErrors.length > 0) body.errors = freshErrors;
  return body;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /api/graphql. Returns true when the request was this endpoint's (any
 * status it answered with), false otherwise so the router can fall through.
 */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (req.method !== 'POST' || pathOf(req) !== '/api/graphql') return false;
  const text = await readBody(req, 1_048_576);
  if (text === null) {
    sendJson(res, 413, { errors: [{ message: 'request body too large' }] });
    return true;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
    return true;
  }
  const ctx: ExecContext = { store, viewer: viewerLogin(store), errors: [] };
  if (Array.isArray(parsed)) {
    // GitHub's operation batching: one answer per operation, in request order.
    sendJson(res, 200, parsed.map((entry) => runOperation(entry, ctx)));
    return true;
  }
  sendJson(res, 200, runOperation(parsed, ctx));
  return true;
}
