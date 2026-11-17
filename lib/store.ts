// The forge's data model: one in-memory store behind every surface
// (git smart HTTP, REST v3, GraphQL, MCP), so an object created over
// one surface reads back identically over the others. Nothing here
// reads a wall clock: ordering comes from insertion sequence numbers
// and timestamps from the trial's fixed MAKEFUN_TRIAL_NOW, which
// keeps two runs of a trial byte-identical in everything the suite
// can observe.

import { ObjectStore } from './gitstore.ts';

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  /** Insertion order within the repository, for created-sort. */
  seq: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** Branch tips captured when the pull request was opened. */
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface RepoRec {
  name: string;
  /** The login of the token's owner, bound on first addressed access. */
  ownerLogin: string | null;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  git: ObjectStore;
  /** Full refname ("refs/heads/main") -> object id. */
  refs: Map<string, string>;
  labels: Set<string>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  nextCommentId: number;
  nextSeq: number;
}

export class ForgeStore {
  repos = new Map<string, RepoRec>();
  /** Global counters for ids that only need to be stable and positive. */
  private repoIdCounter = 0;
  repoIds = new Map<string, number>();

  createRepo(name: string, description: string, isPrivate: boolean): RepoRec {
    const repo: RepoRec = {
      name,
      ownerLogin: null,
      description,
      isPrivate,
      defaultBranch: 'main',
      git: new ObjectStore(),
      refs: new Map(),
      labels: new Set(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      nextSeq: 1,
    };
    this.repos.set(name, repo);
    this.repoIdCounter += 1;
    this.repoIds.set(name, this.repoIdCounter);
    return repo;
  }

  /**
   * Resolve a repository addressed as /{owner}/{name}. The token
   * belongs to one login; the first owner a repository is addressed
   * under binds as that login, and any other owner is a 404 — the
   * same repository name under another owner does not exist here.
   */
  resolve(owner: string, name: string): RepoRec | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (repo.ownerLogin === null) {
      repo.ownerLogin = owner;
      return repo;
    }
    return repo.ownerLogin === owner ? repo : null;
  }

  /** The bound viewer login, once any repository has been addressed. */
  get viewerLogin(): string | null {
    for (const repo of this.repos.values()) {
      if (repo.ownerLogin !== null) return repo.ownerLogin;
    }
    return null;
  }
}

/** The trial's fixed "now", the only timestamp source the forge uses. */
export function trialNow(): Date {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date('2026-01-01T00:00:00.000Z');
}

export function trialNowIso(): string {
  return trialNow().toISOString();
}

/** "Name <email> epoch +0000" for commits the forge itself authors. */
export function forgeIdent(): string {
  const epoch = Math.floor(trialNow().getTime() / 1000);
  return `Forge <forge@localhost> ${epoch} +0000`;
}
