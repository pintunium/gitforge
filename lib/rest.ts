// The REST v3 surface: repositories, branches, commits, contents,
// labels, issues, comments and pull requests, in GitHub's shapes and
// status codes. Every handler works on the shared ForgeStore, so
// anything created here is the same object the git, GraphQL and MCP
// surfaces serve. Errors are JSON with a message, always.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildCommit,
  buildTreeFromFiles,
  flattenTree,
  mergeBase,
  parseCommit,
  parseTree,
  type ObjectStore,
} from './gitstore.ts';
import { forgeIdent, trialNowIso, type ForgeStore, type PullRec, type RepoRec } from './store.ts';

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  requestCounter += 1;
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': `forge-${requestCounter}`, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `forge-${requestCounter}`,
    ...headers,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { message: err.message });
  } else {
    sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
  }
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Parse a JSON request body; an empty body is {}, malformed is 400. */
export function jsonBody(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function baseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

// ---------------------------------------------------------------------------
// Repository helpers

export function repoJson(req: IncomingMessage, store: ForgeStore, repo: RepoRec): Record<string, unknown> {
  const owner = repo.ownerLogin ?? store.viewerLogin ?? '';
  const base = baseUrl(req);
  return {
    id: store.repoIds.get(repo.name) ?? 0,
    name: repo.name,
    full_name: owner === '' ? repo.name : `${owner}/${repo.name}`,
    owner: { login: owner, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${base}/${owner}/${repo.name}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}`,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    pushed_at: trialNowIso(),
  };
}

export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a ref parameter (branch name or commit oid) to a commit oid. */
export function resolveRef(repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  const byBranch = branchTip(repo, ref);
  if (byBranch !== null) return byBranch;
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const obj = repo.git.read(ref.toLowerCase());
    if (obj !== undefined && obj.type === 'commit') return ref.toLowerCase();
  }
  return null;
}

/** Commit one file change (create/update/delete) onto a branch. */
function commitFileChange(
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const git = repo.git;
  const tip = branchTip(repo, branch);
  let files = new Map<string, { mode: string; oid: string }>();
  if (tip !== null) {
    const commit = parseCommit(git.read(tip)!.data);
    files = flattenTree(git, commit.tree);
  }
  let blobSha: string | null = null;
  if (content !== null) {
    blobSha = git.write('blob', content);
    const existing = files.get(path);
    files.set(path, { mode: existing?.mode ?? '100644', oid: blobSha });
  } else {
    files.delete(path);
  }
  const tree = buildTreeFromFiles(git, files);
  const ident = forgeIdent();
  const commitSha = git.write(
    'commit',
    buildCommit({
      tree,
      parents: tip === null ? [] : [tip],
      author: ident,
      committer: ident,
      message: message === '' ? `Update ${path}` : message,
    }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha };
}

/** The current blob oid of a path on a ref, or null. */
function fileAt(repo: RepoRec, ref: string | null, path: string): { mode: string; oid: string } | null {
  const commitOid = resolveRef(repo, ref);
  if (commitOid === null) return null;
  const commit = parseCommit(repo.git.read(commitOid)!.data);
  return flattenTree(repo.git, commit.tree).get(path) ?? null;
}

// ---------------------------------------------------------------------------
// Handlers

function handleCreateRepo(req: IncomingMessage, res: ServerResponse, store: ForgeStore, body: Record<string, unknown>): void {
  const name = str(body.name);
  if (name === '') throw new HttpError(422, 'name is required');
  if (store.repos.has(name)) throw new HttpError(422, `name already exists on this account: ${name}`);
  const repo = store.createRepo(name, str(body.description), body.private === true);
  sendJson(res, 201, repoJson(req, store, repo));
}

function handleListUserRepos(req: IncomingMessage, res: ServerResponse, store: ForgeStore, url: URL): void {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const all = [...store.repos.values()];
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const linkUrl = (p: number): string => `${baseUrl(req)}/api/v3/user/repos?page=${p}&per_page=${perPage}`;
  if (page * perPage < all.length) links.push(`<${linkUrl(page + 1)}>; rel="next"`, `<${linkUrl(Math.ceil(all.length / perPage))}>; rel="last"`);
  if (page > 1) links.push(`<${linkUrl(page - 1)}>; rel="prev"`, `<${linkUrl(1)}>; rel="first"`);
  if (links.length > 0) headers.link = links.join(', ');
  sendJson(res, 200, slice.map((repo) => repoJson(req, store, repo)), headers);
}

function issueJson(store: ForgeStore, repo: RepoRec, issue: { number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
    user: { login: repo.ownerLogin ?? store.viewerLogin ?? '' },
    comments: repo.issues.get(issue.number)?.comments.length ?? 0,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
  };
}

function pullJson(store: ForgeStore, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const owner = repo.ownerLogin ?? store.viewerLogin ?? '';
  return {
    id: pull.number,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: owner },
    head: { ref: pull.headRef, sha: branchTip(repo, pull.headRef) ?? pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open',
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
  };
}

/** Line-level diff counts between two texts (LCS over lines). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: b.length - common, deletions: a.length - common };
}

export function pullFiles(repo: RepoRec, pull: PullRec): Record<string, unknown>[] {
  const git: ObjectStore = repo.git;
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const mb = mergeBase(git, baseTip, headTip) ?? pull.baseSha;
  const baseFiles = flattenTree(git, parseCommit(git.read(mb)!.data).tree);
  const headFiles = flattenTree(git, parseCommit(git.read(headTip)!.data).tree);
  const out: Record<string, unknown>[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const oldText = before === undefined ? '' : git.read(before.oid)!.data.toString('utf8');
    const newText = after === undefined ? '' : git.read(after.oid)!.data.toString('utf8');
    const { additions, deletions } = lineDiffCounts(oldText, newText);
    out.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: after?.oid ?? before!.oid,
    });
  }
  return out;
}

/**
 * Squash-merge a pull request onto its base branch: the head's
 * changes since the merge base are applied to the current base tip
 * as one new commit. Throws HttpError 405 when a path changed on
 * both sides to different results. Shared by REST and GraphQL.
 */
export function squashMergePull(store: ForgeStore, repo: RepoRec, pull: PullRec): { sha: string } {
  void store;
  if (pull.state !== 'open') throw new HttpError(405, 'Pull Request is not open');
  const git = repo.git;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) throw new HttpError(405, 'Pull Request is not mergeable');
  const mb = mergeBase(git, baseTip, headTip);
  if (mb === null) throw new HttpError(405, 'Pull Request is not mergeable');
  const baseAtMb = flattenTree(git, parseCommit(git.read(mb)!.data).tree);
  const headFiles = flattenTree(git, parseCommit(git.read(headTip)!.data).tree);
  const currentBase = flattenTree(git, parseCommit(git.read(baseTip)!.data).tree);
  // Three-way check: a path the head changed that the base also
  // changed since the merge base, to a different result, conflicts.
  const mergedFiles = new Map(currentBase);
  const paths = new Set([...baseAtMb.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const atMb = baseAtMb.get(path);
    const atHead = headFiles.get(path);
    if (atMb?.oid === atHead?.oid) continue; // head did not change it
    const atBase = currentBase.get(path);
    const baseChanged = atBase?.oid !== atMb?.oid;
    if (baseChanged && atBase?.oid !== atHead?.oid) {
      throw new HttpError(405, 'Pull Request is not mergeable: conflict');
    }
    if (atHead === undefined) mergedFiles.delete(path);
    else mergedFiles.set(path, atHead);
  }
  const tree = buildTreeFromFiles(git, mergedFiles);
  const ident = forgeIdent();
  const commitSha = git.write(
    'commit',
    buildCommit({
      tree,
      parents: [baseTip],
      author: ident,
      committer: ident,
      message: `${pull.title} (#${pull.number})${pull.body === '' ? '' : `\n\n${pull.body}`}`,
    }),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = trialNowIso();
  pull.mergeCommitSha = commitSha;
  return { sha: commitSha };
}

/** True when the pull request's head conflicts with its base today. */
export function pullHasConflict(repo: RepoRec, pull: PullRec): boolean {
  const git = repo.git;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return true;
  const mb = mergeBase(git, baseTip, headTip);
  if (mb === null) return true;
  const baseAtMb = flattenTree(git, parseCommit(git.read(mb)!.data).tree);
  const headFiles = flattenTree(git, parseCommit(git.read(headTip)!.data).tree);
  const currentBase = flattenTree(git, parseCommit(git.read(baseTip)!.data).tree);
  for (const path of new Set([...baseAtMb.keys(), ...headFiles.keys()])) {
    const atMb = baseAtMb.get(path);
    const atHead = headFiles.get(path);
    if (atMb?.oid === atHead?.oid) continue;
    const atBase = currentBase.get(path);
    if (atBase?.oid !== atMb?.oid && atBase?.oid !== atHead?.oid) return true;
  }
  return false;
}

function mergePull(req: IncomingMessage, res: ServerResponse, store: ForgeStore, repo: RepoRec, pull: PullRec): void {
  const { sha } = squashMergePull(store, repo, pull);
  sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
  void req;
}

// ---------------------------------------------------------------------------
// The router

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: ForgeStore, url: URL): Promise<void> {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const raw = await readBody(req);
  const body = (): Record<string, unknown> => jsonBody(raw);

  try {
    if (path === '/api/v3' && method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    if (path === '/api/v3/meta' && method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
      return;
    }
    if (path === '/api/v3/user/repos' && method === 'POST') {
      handleCreateRepo(req, res, store, body());
      return;
    }
    if (path === '/api/v3/user/repos' && method === 'GET') {
      handleListUserRepos(req, res, store, url);
      return;
    }
    if (path === '/api/v3/user' && method === 'GET') {
      const login = store.viewerLogin ?? 'adaiversen';
      sendJson(res, 200, { login, id: 1000, type: 'User', name: login });
      return;
    }

    const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoMatch === null) throw new HttpError(404, 'Not Found');
    const owner = decodeURIComponent(repoMatch[1]!);
    const repoName = decodeURIComponent(repoMatch[2]!);
    const rest = repoMatch[3] ?? '';
    const repo = store.resolve(owner, repoName);
    if (repo === null) throw new HttpError(404, 'Not Found');

    if (rest === '' && method === 'GET') {
      sendJson(res, 200, repoJson(req, store, repo));
      return;
    }
    if (rest === '' && method === 'PATCH') {
      const patch = body();
      if (typeof patch.description === 'string') repo.description = patch.description;
      if (typeof patch.private === 'boolean') repo.isPrivate = patch.private;
      sendJson(res, 200, repoJson(req, store, repo));
      return;
    }
    if (rest === '' && method === 'DELETE') {
      store.repos.delete(repo.name);
      store.repoIds.delete(repo.name);
      sendJson(res, 204, null);
      return;
    }

    if (rest === '/branches' && method === 'GET') {
      const branches = [];
      for (const [ref, oid] of repo.refs) {
        if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
      }
      branches.sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, branches);
      return;
    }
    const gitRefMatch = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (gitRefMatch !== null && method === 'GET') {
      const branch = decodeURIComponent(gitRefMatch[1]!);
      const sha = branchTip(repo, branch);
      if (sha === null) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
      return;
    }
    const branchMatch = /^\/branches\/(.+)$/.exec(rest);
    if (branchMatch !== null && method === 'GET') {
      const branch = decodeURIComponent(branchMatch[1]!);
      const sha = branchTip(repo, branch);
      if (sha === null) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
    if (rest === '/git/refs' && method === 'POST') {      const input = body();
      const ref = str(input.ref);
      const sha = str(input.sha).toLowerCase();
      const obj = repo.git.read(sha);
      if (!ref.startsWith('refs/') || obj === undefined || obj.type !== 'commit') throw new HttpError(422, 'Invalid ref or sha');
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
      return;
    }
    if (rest === '/commits' && method === 'GET') {
      const start = resolveRef(repo, url.searchParams.get('sha'));
      if (start === null) {
        sendJson(res, 200, []);
        return;
      }
      const commits: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const queue = [start];
      while (queue.length > 0 && commits.length < 100) {
        const oid = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.git.read(oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        const commit = parseCommit(obj.data);
        const authorParts = /^(.*) <(.*)> (\d+) /.exec(commit.author);
        commits.push({
          sha: oid,
          commit: {
            message: commit.message,
            author: { name: authorParts?.[1] ?? '', email: authorParts?.[2] ?? '', date: trialNowIso() },
            committer: { name: authorParts?.[1] ?? '', email: authorParts?.[2] ?? '', date: trialNowIso() },
            tree: { sha: commit.tree },
          },
          parents: commit.parents.map((p) => ({ sha: p })),
        });
        for (const parent of commit.parents) queue.push(parent);
      }
      sendJson(res, 200, commits);
      return;
    }

    const contentsMatch = /^\/contents\/(.+)$/.exec(rest);
    if (contentsMatch !== null) {
      const filePath = contentsMatch[1]!.split('/').map((seg) => decodeURIComponent(seg)).join('/');
      const ref = url.searchParams.get('ref');
      if (method === 'GET') {
        const commitOid = resolveRef(repo, ref);
        if (commitOid === null) throw new HttpError(404, 'Not Found');
        const commit = parseCommit(repo.git.read(commitOid)!.data);
        const files = flattenTree(repo.git, commit.tree);
        const file = files.get(filePath);
        if (file !== undefined) {
          const data = repo.git.read(file.oid)!.data;
          sendJson(res, 200, {
            type: 'file',
            name: filePath.split('/').pop(),
            path: filePath,
            sha: file.oid,
            size: data.length,
            encoding: 'base64',
            content: data.toString('base64'),
          });
          return;
        }
        // Directory listing: immediate children of filePath.
        const prefix = `${filePath}/`;
        const children = new Map<string, { type: string; sha: string }>();
        for (const [p, entry] of files) {
          if (!p.startsWith(prefix)) continue;
          const tail = p.slice(prefix.length);
          const head = tail.split('/')[0]!;
          if (tail.includes('/')) {
            if (!children.has(head)) {
              // The child's sha is its subtree oid; find it by walking.
              children.set(head, { type: 'dir', sha: subtreeOid(repo, commit.tree, `${prefix}${head}`) ?? entry.oid });
            }
          } else {
            children.set(head, { type: 'file', sha: entry.oid });
          }
        }
        if (children.size > 0) {
          const listing = [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, info]) => ({
            type: info.type,
            name,
            path: `${prefix}${name}`,
            sha: info.sha,
          }));
          sendJson(res, 200, listing);
          return;
        }
        throw new HttpError(404, 'Not Found');
      }
      if (method === 'PUT') {
        const input = body();
        const branch = str(input.branch) || repo.defaultBranch;
        const existing = fileAt(repo, branch, filePath);
        const givenSha = typeof input.sha === 'string' ? input.sha.toLowerCase() : null;
        if (existing !== null && givenSha !== null && givenSha !== existing.oid) {
          throw new HttpError(409, 'SHA mismatch: the file has changed');
        }
        if (existing === null && givenSha !== null) throw new HttpError(422, 'sha supplied for a file that does not exist');
        const content = Buffer.from(str(input.content), 'base64');
        const { commitSha, blobSha } = commitFileChange(repo, branch, filePath, content, str(input.message));
        sendJson(res, existing !== null ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, encoding: 'base64' },
          commit: { sha: commitSha },
        });
        return;
      }
      if (method === 'DELETE') {
        const input = body();
        const branch = str(input.branch) || repo.defaultBranch;
        const existing = fileAt(repo, branch, filePath);
        if (existing === null) throw new HttpError(404, 'Not Found');
        const givenSha = typeof input.sha === 'string' ? input.sha.toLowerCase() : null;
        if (givenSha !== null && givenSha !== existing.oid) throw new HttpError(409, 'SHA mismatch: the file has changed');
        const { commitSha } = commitFileChange(repo, branch, filePath, null, str(input.message));
        sendJson(res, 200, { content: null, commit: { sha: commitSha } });
        return;
      }
    }

    if (rest === '/labels' && method === 'POST') {
      const input = body();
      const name = str(input.name);
      if (name === '') throw new HttpError(422, 'name is required');
      repo.labels.add(name);
      sendJson(res, 201, { name, color: str(input.color) || 'ededed', description: null });
      return;
    }

    if (rest === '/issues' && method === 'POST') {
      const input = body();
      const labels = Array.isArray(input.labels) ? input.labels.map((l) => (typeof l === 'string' ? l : str((l as Record<string, unknown>)?.name))) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) throw new HttpError(422, `Label "${label}" does not exist`);
      }
      const number = repo.nextNumber++;
      const issue = {
        number,
        title: str(input.title),
        body: str(input.body),
        state: 'open' as const,
        labels,
        comments: [],
        seq: repo.nextSeq++,
      };
      repo.issues.set(number, issue);
      sendJson(res, 201, issueJson(store, repo, issue));
      return;
    }
    if (rest === '/issues' && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      const perPage = Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30);
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      sendJson(res, 200, list.slice((page - 1) * perPage, page * perPage).map((i) => issueJson(store, repo, i)));
      return;
    }
    const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
    if (issueMatch !== null) {
      const number = Number(issueMatch[1]);
      const issue = repo.issues.get(number);
      if (issue === undefined) throw new HttpError(404, 'Not Found');
      if (issueMatch[2] === '/comments') {
        if (method === 'POST') {
          const input = body();
          const comment = { id: repo.nextCommentId++, body: str(input.body) };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: repo.ownerLogin ?? '' }, created_at: trialNowIso() });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: repo.ownerLogin ?? '' }, created_at: trialNowIso() })));
          return;
        }
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(store, repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const input = body();
        if (input.state === 'closed' || input.state === 'open') issue.state = input.state;
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        sendJson(res, 200, issueJson(store, repo, issue));
        return;
      }
    }

    if (rest === '/pulls' && method === 'POST') {
      const input = body();
      const headRef = str(input.head).replace(/^[^:]+:/, '');
      const baseRef = str(input.base).replace(/^[^:]+:/, '');
      const headSha = branchTip(repo, headRef);
      const baseSha = branchTip(repo, baseRef);
      if (headSha === null || baseSha === null) throw new HttpError(422, 'Invalid head or base branch');
      const number = repo.nextNumber++;
      const pull: PullRec = {
        number,
        title: str(input.title),
        body: str(input.body),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef,
        baseRef,
        headSha,
        baseSha,
        seq: repo.nextSeq++,
      };
      repo.pulls.set(number, pull);
      sendJson(res, 201, pullJson(store, repo, pull));
      return;
    }
    if (rest === '/pulls' && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const perPage = Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30);
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => (state === 'closed' ? p.state === 'closed' : p.state === 'open'));
      list.sort((a, b) => b.seq - a.seq);
      sendJson(res, 200, list.slice((page - 1) * perPage, page * perPage).map((p) => pullJson(store, repo, p)));
      return;
    }
    const pullMatch = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(rest);
    if (pullMatch !== null) {
      const number = Number(pullMatch[1]);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new HttpError(404, 'Not Found');
      if (pullMatch[2] === '/files' && method === 'GET') {
        sendJson(res, 200, pullFiles(repo, pull));
        return;
      }
      if (pullMatch[2] === '/merge' && method === 'PUT') {
        body();
        mergePull(req, res, store, repo, pull);
        return;
      }
      if (pullMatch[2] === undefined && method === 'GET') {
        sendJson(res, 200, pullJson(store, repo, pull));
        return;
      }
    }

    throw new HttpError(404, 'Not Found');
  } catch (err) {
    sendError(res, err);
  }
}

/** Walk a tree by path segments to a subtree oid (for dir listings). */
function subtreeOid(repo: RepoRec, rootTree: string, path: string): string | null {
  let current = rootTree;
  for (const segment of path.split('/')) {
    const obj = repo.git.read(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = flattenTreeEntry(obj.data, segment);
    if (entry === null) return null;
    current = entry;
  }
  return current;
}

function flattenTreeEntry(treeData: Buffer, name: string): string | null {
  for (const entry of parseTree(treeData)) {
    if (entry.name === name) return entry.oid;
  }
  return null;
}
