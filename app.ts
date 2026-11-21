// The entry's HTTP surface: routing, auth and wire discipline in one place, with the four
// contest surfaces delegated to their modules (git.ts, rest.ts, graphql.ts, mcp.ts).
//
// Assembly contract (what app.ts expects from a sibling module):
//   - The module is loaded with a dynamic import when the first request arrives; a missing file,
//     a load failure, or a module that exports no recognised handler falls back to an inline
//     501 stub for that surface, and the reason is written to stderr. The server never fails
//     to start because a module is missing.
//   - A handler is any of these exports, tried in order: `handle`, `default`,
//     then the surface name (`handleRest` / `handleGit` / `handleGraphql` / `handleMcp`,
//     `restHandler` / `gitHandler` / `graphqlHandler` / `mcpHandler`).
//   - It is called with the shared store as its third argument: rest, GraphQL and MCP as
//     `await handler(req, res, store)`; git as
//     `await handler(req, res, store, owner, repo, subpath, { token })`, where owner/repo/
//     subpath are parsed from `/<owner>/<repo>.git/*`. Returning exactly `false` means "not
//     handled" and app.ts answers 404. Otherwise the handler must end the response; if it
//     returns without ending it, app.ts answers 501.
//   - The shared store is the `Store` from store.ts, so the surfaces share one state: a
//     repository created over REST must be visible to git, GraphQL and MCP, and an issue
//     created over GraphQL or MCP must be visible to REST. If git.ts exports a store factory
//     (`createStore` / `createDb` / `newStore`) or a `store` object, that store is the shared
//     one; otherwise app.ts builds a fresh `Store` and passes it to every module.
//
// Wire discipline enforced here (the protocol group's checks):
//   - Every reply carries a non-empty X-GitHub-Request-Id (a per-process counter, deterministic).
//   - Every JSON reply carries content-type application/json.
//   - Every route except GET /healthz requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`;
//     missing or wrong is 401 {"message":"Bad credentials"}. (When the token is unset in the
//     environment there is nothing to check against, so auth is open — the trial always sets it.)
//   - GET /healthz answers 200 {"ok":true} with no token; GET /api/v3 and /api/v3/ answer the
//     starter's API root with X-Oauth-Scopes: repo, read:org.
//   - Anything unrouted answers 404 {"message":"Not Found"}.
//   - app.ts never reads a request body: the modules own their streams (git pack data is binary).
//   - Determinism: no Date.now()/new Date()/Math.random() in served state; trialNow() reads
//     MAKEFUN_TRIAL_NOW with the fixed fallback.

import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The fixed instant served state is stamped with (MAKEFUN_TRIAL_NOW, else the trial's epoch). */
export function trialNow(): string {
  return process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-21T06:30:00.000Z';
}

/** The bearer token the env presents (MAKEFUN_SHOP_TOKEN); '' when the environment sets none. */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** A per-process request counter: the X-GitHub-Request-Id values, deterministic, never empty. */
let requestCounter = 0;

/** The shared store type: the `Store` class from store.ts, the modules' source of truth. */
export type ForgeStore = Store;

/** The shared store app.ts builds when no module supplies one. */
function createStore(): Store {
  return new Store();
}

/** What app.ts carries per request: the shared store, the expected bearer token, a deterministic clock and the JSON sender. */
export interface HandlerContext {
  readonly store: Store;
  readonly token: string;
  readonly trialNow: () => string;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown, headers?: Readonly<Record<string, string>>) => void;
}

/** A surface handler: false means "not handled" (app.ts answers 404); anything else must end res.
 *  rest/GraphQL/MCP take (req, res, store); git additionally takes (owner, repo, subpath, opts). */
export type SurfaceHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  ...extra: unknown[]
) => unknown | Promise<unknown>;

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (res.writableEnded) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Whether the request carries the expected bearer token (open when the environment sets none). */
function authorized(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${EXPECTED_TOKEN}`;
}

/** Load one surface module and resolve its handler, or null (stub) with a stderr line saying why. */
async function loadHandler(specifier: string, names: readonly string[]): Promise<SurfaceHandler | null> {
  if (!existsSync(new URL(specifier, import.meta.url))) {
    process.stderr.write(`[entry] ${specifier} is missing; its surface answers 501 until the module lands\n`);
    return null;
  }
  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch (err) {
    process.stderr.write(`[entry] ${specifier} could not be loaded (${err instanceof Error ? err.message : String(err)}); its surface answers 501\n`);
    return null;
  }
  const record = mod as Record<string, unknown>;
  for (const name of names) {
    if (typeof record[name] === 'function') return record[name] as SurfaceHandler;
  }
  process.stderr.write(`[entry] ${specifier} exports no handler (${names.join(', ')}); its surface answers 501\n`);
  return null;
}

/** Take the shared store from git.ts when it offers one, else a fresh Store. */
function sharedStoreFrom(gitModule: unknown): Store {
  const record = gitModule as Record<string, unknown> | null;
  if (record !== null && typeof record === 'object') {
    for (const name of ['createStore', 'createDb', 'newStore']) {
      if (typeof record[name] === 'function') {
        try {
          const store = (record[name] as () => unknown)();
          if (store !== null && typeof store === 'object') return store as Store;
        } catch {
          // A throwing factory is not a store; fall through to the built-in one.
        }
      }
    }
    if (record.store !== null && typeof record.store === 'object') return record.store as Store;
  }
  return createStore();
}

/** The four surfaces' handlers plus the shared store, loaded once (missing modules become stubs). */
interface Loaded {
  readonly git: SurfaceHandler | null;
  readonly rest: SurfaceHandler | null;
  readonly graphql: SurfaceHandler | null;
  readonly mcp: SurfaceHandler | null;
  readonly store: Store;
}

let loadedPromise: Promise<Loaded> | null = null;

function loadSurfaces(): Promise<Loaded> {
  if (loadedPromise !== null) return loadedPromise;
  loadedPromise = (async (): Promise<Loaded> => {
    let gitModule: unknown = null;
    if (existsSync(new URL('./git.ts', import.meta.url))) {
      try {
        gitModule = await import('./git.ts');
      } catch (err) {
        process.stderr.write(`[entry] ./git.ts could not be loaded (${err instanceof Error ? err.message : String(err)}); its surface answers 501\n`);
      }
    } else {
      process.stderr.write('[entry] ./git.ts is missing; the git surface answers 501 until the module lands\n');
    }
    let git: SurfaceHandler | null = null;
    if (gitModule !== null) {
      const record = gitModule as Record<string, unknown>;
      for (const name of ['handle', 'default', 'handleGit', 'gitHandler']) {
        if (typeof record[name] === 'function') {
          git = record[name] as SurfaceHandler;
          break;
        }
      }
      if (git === null) process.stderr.write('[entry] ./git.ts exports no handler (handle, default, handleGit, gitHandler); the git surface answers 501\n');
    }
    const rest = await loadHandler('./rest.ts', ['handle', 'default', 'handleRest', 'restHandler']);
    const graphql = await loadHandler('./graphql.ts', ['handle', 'default', 'handleGraphql', 'handleGraphQL', 'graphqlHandler']);
    const mcp = await loadHandler('./mcp.ts', ['handle', 'default', 'handleMcp', 'mcpHandler']);
    return { git, rest, graphql, mcp, store: sharedStoreFrom(gitModule) };
  })();
  return loadedPromise;
}

/** A 501 stub for a surface whose module is missing: the route exists, the implementation does not. */
function stub(res: ServerResponse): void {
  sendJson(res, 501, { message: 'Not Implemented' });
}

/**
 * Run one surface handler: false (or a throw) falls through to the caller's fallback; a handler
 * that returns without ending the response is answered 501 rather than left hanging.
 * The handler receives the shared store as its third argument, plus `extraArgs` (git's
 * owner/repo/subpath/opts); it never receives the HandlerContext object itself.
 */
async function runHandler(
  handler: SurfaceHandler | null,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
  extraArgs: readonly unknown[] = [],
): Promise<boolean> {
  if (handler === null) {
    stub(res);
    return true;
  }
  let outcome: unknown;
  try {
    outcome = await handler(req, res, ctx.store, ...extraArgs);
  } catch (err) {
    process.stderr.write(`[entry] surface handler threw (${err instanceof Error ? err.message : String(err)})\n`);
    if (!res.writableEnded) sendJson(res, 500, { message: 'Internal Server Error' });
    return true;
  }
  if (outcome === false) return false;
  if (!res.writableEnded) {
    process.stderr.write('[entry] surface handler returned without answering; replying 501\n');
    stub(res);
  }
  return true;
}

/** `<owner>/<repo>.git` with any smart-HTTP tail, or null when the path is not a git route. */
function gitRouteOf(path: string): { owner: string; repo: string; tail: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (match === null) return null;
  let owner = match[1] ?? '';
  let repo = match[2] ?? '';
  try {
    owner = decodeURIComponent(owner);
    repo = decodeURIComponent(repo);
  } catch {
    return null;
  }
  return { owner, repo, tail: match[3] ?? '' };
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      res.setHeader('x-github-request-id', `req-${(requestCounter += 1)}`);

      // The env's boot check calls this twice: 200 {"ok":true}. No token on the probe.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Every other route requires the bearer token.
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }

      // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      const loaded = await loadSurfaces();
      const ctx: HandlerContext = { store: loaded.store, token: EXPECTED_TOKEN, trialNow, sendJson };

      // GraphQL v4: POST only.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        await runHandler(loaded.graphql, req, res, ctx);
        return;
      }

      // MCP over streamable HTTP: POST only.
      if (path === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        await runHandler(loaded.mcp, req, res, ctx);
        return;
      }

      // REST v3: everything under /api/v3/.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (await runHandler(loaded.rest, req, res, ctx)) return;
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // git smart HTTP: /<owner>/<repo>.git/...
      const gitRoute = gitRouteOf(path);
      if (gitRoute !== null) {
        if (await runHandler(loaded.git, req, res, ctx, [gitRoute.owner, gitRoute.repo, gitRoute.tail, { token: ctx.token }])) return;
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      process.stderr.write(`[entry] request failed (${err instanceof Error ? err.message : String(err)})\n`);
      if (!res.writableEnded) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The peer went away; nothing left to write.
        }
      }
    });
  });
}
