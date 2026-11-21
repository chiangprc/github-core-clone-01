// store.ts — the single in-memory source of truth for the forge.
// Every timestamp in served state comes from trialNow(), never the wall clock.

import { createHash } from 'node:crypto';

/** The trial's fixed "now": MAKEFUN_TRIAL_NOW when set, else the trial deadline instant. */
export function trialNow(): string {
  const value = process.env.MAKEFUN_TRIAL_NOW;
  return value !== undefined && value !== '' ? value : '2026-11-21T06:30:00.000Z';
}

export interface Comment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  user: { login: string };
  created_at: string;
  updated_at: string;
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: { login: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  mergeable: boolean;
}

export interface Repo {
  owner: string;
  name: string;
  full_name: string;
  description: string;
  default_branch: string;
  private: boolean;
  created_at: string;
  updated_at: string;
  refs: Map<string, string>;
  objects: Map<string, { type: string; data: Buffer }>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, { name: string; color: string; description: string }>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

/** GitHub's six default labels, with their stock colours and descriptions. */
const DEFAULT_LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
];

export class Store {
  repos = new Map<string, Repo>();

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  /** Create a repo (idempotent: an existing repo is returned unchanged). */
  createRepo(owner: string, name: string, description = ''): Repo {
    const existing = this.getRepo(owner, name);
    if (existing !== undefined) return existing;
    const now = trialNow();
    const repo: Repo = {
      owner,
      name,
      full_name: `${owner}/${name}`,
      description,
      default_branch: 'main',
      private: false,
      created_at: now,
      updated_at: now,
      refs: new Map<string, string>(),
      objects: new Map<string, { type: string; data: Buffer }>(),
      issues: new Map<number, Issue>(),
      pulls: new Map<number, Pull>(),
      labels: new Map<string, { name: string; color: string; description: string }>(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    for (const label of DEFAULT_LABELS) repo.labels.set(label.name, { ...label });
    this.repos.set(repo.full_name, repo);
    return repo;
  }
}

let requestCounter = 0;

/**
 * A deterministic, non-empty id for one request: a per-process counter plus a hash of the
 * method and path. No randomness, no clock.
 */
export function requestId(req: { method?: string; url?: string }): string {
  requestCounter += 1;
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';
  const hash = createHash('sha1').update(`${method} ${url}`).digest('hex').slice(0, 12);
  return `req-${requestCounter}-${hash}`;
}
