// mcp.ts — Model Context Protocol over streamable HTTP (POST /mcp) for the
// github-core-clone-01 entry.
//
// Speaks both protocol eras the suite accepts: the modern 2026-07-28 revision
// (`server/discover`, no handshake, no session) and the legacy handshake
// (`initialize` + `notifications/initialized`, optional Mcp-Session-Id). Answers
// are single JSON bodies (no SSE stream). The six tools the suite calls are
// listed, exactly those six, with github-mcp-server's canonical names:
//
//   create_repo, get_repo, create_issue, list_issues, create_pull_request,
//   merge_pull_request
//
// Tool results are JSON text mirroring the REST shapes, plus structuredContent.
// Auth: the same bearer token as REST (MAKEFUN_SHOP_TOKEN). No token header ->
// HTTP 401. Unknown tool -> JSON-RPC -32602. Unknown method -> -32601.
// Malformed JSON body -> HTTP 400 with JSON-RPC -32700. Missing required
// arguments -> a tool result with isError: true.
// Determinism: no Date.now()/new Date()/Math.random() in served state; created
// timestamps use trialNow() from ./store.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as storeModule from './store.ts';
import type { Store } from './store.ts';
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

function repoNumericId(repo: Record<string, unknown>): number {
  const id = repo.id;
  if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
  if (typeof id === 'string' && /^\d+$/.test(id) && Number(id) > 0) return Number(id);
  const fullName = typeof repo.full_name === 'string' ? repo.full_name : `${String(repo.owner ?? '')}/${String(repo.name ?? '')}`;
  // The same FNV-1a hash rest.ts uses, so MCP repo ids byte-match REST's.
  return (fnv1a(fullName) % 2_147_483_646) + 1;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
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
// Store access
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

function createRepoInStore(store: Store, name: string, description: string, isPrivate: boolean): RepoRec {
  const viewer = viewerLogin(store);
  const s = store as unknown as Record<string, unknown>;
  const creator = s.createRepo;
  if (typeof creator === 'function') {
    const created = (creator as (o: string, n: string, d?: string) => unknown).call(store, viewer, name, description);
    if (isRecord(created)) {
      if (typeof description === 'string') created.description = description;
      created.private = isPrivate;
      return created;
    }
  }
  const repo: RepoRec = {
    id: (fnv1a(`repo:${viewer}/${name}`) % 2_147_483_646) + 1,
    owner: viewer,
    name,
    full_name: `${viewer}/${name}`,
    description,
    private: isPrivate,
    default_branch: 'main',
    refs: new Map(),
    objects: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: [],
  };
  const repos = s.repos;
  if (repos instanceof Map) repos.set(`${viewer}/${name}`, repo);
  return repo;
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

function mapGet(container: unknown, key: string): unknown {
  if (container instanceof Map) return container.get(key);
  if (isRecord(container)) return container[key];
  return undefined;
}

function refShaOf(repo: RepoRec, branch: string): string | null {
  for (const key of [`refs/heads/${branch}`, `heads/${branch}`, branch]) {
    const value = mapGet(repo.refs, key);
    if (typeof value === 'string' && value !== '') return value;
    if (isRecord(value) && typeof value.sha === 'string' && value.sha !== '') return value.sha;
    if (isRecord(value) && typeof value.oid === 'string' && value.oid !== '') return value.oid;
  }
  return null;
}

// ---------------------------------------------------------------------------
// REST-shaped serializers (the same objects REST serves)
// ---------------------------------------------------------------------------

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repoNumericId(repo),
    name: String(repo.name ?? ''),
    full_name: typeof repo.full_name === 'string' ? repo.full_name : `${String(repo.owner ?? '')}/${String(repo.name ?? '')}`,
    private: repo.private === true,
    description: typeof repo.description === 'string' ? repo.description : null,
    default_branch: String(repo.default_branch ?? 'main'),
    owner: { login: String(repo.owner ?? '') },
  };
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const number = Number(issue.number ?? 0);
  // REST's issue id scheme: repoNumericId * 1000000 + number.
  const numericId = repoNumericId(repo) * 1_000_000 + number;
  const user = isRecord(issue.user) && typeof issue.user.login === 'string' ? issue.user.login : '';
  return {
    id: numericId,
    number,
    title: String(issue.title ?? ''),
    body: typeof issue.body === 'string' ? issue.body : '',
    state: String(issue.state ?? 'open').toLowerCase(),
    user: { login: user },
    labels: Array.isArray(issue.labels) ? issue.labels : [],
    assignees: Array.isArray(issue.assignees) ? issue.assignees : [],
    created_at: String(issue.created_at ?? ''),
    updated_at: String(issue.updated_at ?? ''),
  };
}

function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const number = Number(pull.number ?? 0);
  // REST's pull id scheme: repoNumericId * 1000000 + number.
  const numericId = repoNumericId(repo) * 1_000_000 + number;
  const head = isRecord(pull.head) ? pull.head : {};
  const base = isRecord(pull.base) ? pull.base : {};
  const merged = pull.merged_at !== null && pull.merged_at !== undefined && pull.merged_at !== '' ? true : pull.merged === true;
  const user = isRecord(pull.user) && typeof pull.user.login === 'string' ? pull.user.login : '';
  return {
    id: numericId,
    number,
    title: String(pull.title ?? ''),
    body: typeof pull.body === 'string' ? pull.body : '',
    state: String(pull.state ?? 'open').toLowerCase(),
    head: { ref: typeof head.ref === 'string' ? head.ref : '', sha: typeof head.sha === 'string' ? head.sha : '' },
    base: { ref: typeof base.ref === 'string' ? base.ref : '', sha: typeof base.sha === 'string' ? base.sha : '' },
    merged,
    merged_at: merged ? String(pull.merged_at ?? '') : null,
    mergeable: pull.mergeable === true,
    user: { login: user },
    created_at: String(pull.created_at ?? ''),
    updated_at: String(pull.updated_at ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '0.1.0';
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  required: string[];
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

function missingArg(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  return value === undefined || value === null || value === '';
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    required: ['name'],
    run: (store, args) => {
      const name = String(args.name ?? '');
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const repo = createRepoInStore(store, name, description, isPrivate);
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
    required: ['owner', 'repo'],
    run: (store, args) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) throw new Error(`repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found`);
      return repoJson(repo);
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
    required: ['owner', 'repo', 'title'],
    run: (store, args) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) throw new Error(`repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found`);
      const viewer = viewerLogin(store);
      const number = typeof repo.nextIssue === 'number' && repo.nextIssue > 0 ? repo.nextIssue : Math.max(0, ...issueList(repo).map((entry) => Number(entry.number ?? 0))) + 1;
      if (typeof repo.nextIssue === 'number') repo.nextIssue = number + 1;
      const now = nowIso();
      const issue: IssueRec = {
        number,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
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
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
    required: ['owner', 'repo'],
    run: (store, args) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) throw new Error(`repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = issueList(repo).filter((issue) => {
        if (state === 'all') return true;
        return String(issue.state ?? 'open').toLowerCase() === state;
      });
      return list.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (store, args) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) throw new Error(`repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found`);
      const viewer = viewerLogin(store);
      const number = typeof repo.nextPull === 'number' && repo.nextPull > 0 ? repo.nextPull : Math.max(0, ...pullList(repo).map((entry) => Number(entry.number ?? 0))) + 1;
      if (typeof repo.nextPull === 'number') repo.nextPull = number + 1;
      const now = nowIso();
      const headRef = String(args.head ?? '');
      const baseRef = String(args.base ?? '');
      const pull: PullRec = {
        number,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
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
      return pullJson(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (store, args) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) throw new Error(`repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found`);
      const number = Number(args.pull_number);
      const pull = pullList(repo).find((entry) => Number(entry.number) === number);
      if (pull === undefined) throw new Error(`pull request #${number} not found`);
      pull.merged_at = nowIso();
      pull.state = 'closed';
      pull.updated_at = nowIso();
      return pullJson(repo, pull);
    },
  },
];

function toolsListJson(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'discover',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: serverInfo(),
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
  };
}

/** Dispatch one parsed JSON-RPC request. `id` is undefined for notifications. */
function dispatch(body: Record<string, unknown>, store: Store): { status: number; payload: unknown } | null {
  const method = body.method;
  const id = body.id;
  const isNotification = id === undefined;
  if (typeof method !== 'string' || method === '') {
    if (isNotification) return null;
    return { status: 200, payload: rpcError(id, -32600, 'Invalid Request: a method name is required') };
  }
  const params = isRecord(body.params) ? body.params : {};

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification is answered with 202 and no body.
    return { status: 202, payload: null };
  }

  if (method === 'server/discover') {
    return { status: 200, payload: rpcResult(id, discoverResult()) };
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      payload: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, payload: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    return { status: 200, payload: rpcResult(id, { tools: toolsListJson() }) };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) {
      return { status: 200, payload: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    const missing = tool.required.filter((required) => missingArg(args, required));
    if (missing.length > 0) {
      return { status: 200, payload: rpcResult(id, toolError(`Missing required argument: ${missing.join(', ')}`)) };
    }
    try {
      const value = tool.run(store, args);
      return { status: 200, payload: rpcResult(id, toolResult(value)) };
    } catch (err) {
      return { status: 200, payload: rpcResult(id, toolError(err instanceof Error ? err.message : String(err))) };
    }
  }

  return { status: 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /mcp. Returns true when the request was this endpoint's (any status it
 * answered with), false otherwise so the router can fall through.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (req.method !== 'POST' || pathOf(req) !== '/mcp') return false;
  if (!authorized(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return true;
  }
  const text = await readBody(req, 1_048_576);
  if (text === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body too large' } });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC object' } });
    return true;
  }
  const answer = dispatch(parsed, store);
  if (answer === null || answer.payload === null) {
    res.writeHead(answer?.status ?? 202, { 'content-length': 0 });
    res.end();
    return true;
  }
  sendJson(res, answer.status, answer.payload);
  return true;
}
