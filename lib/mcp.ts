// The MCP endpoint at /mcp: Model Context Protocol over Streamable
// HTTP, JSON-RPC 2.0. The server speaks the modern era — it answers
// server/discover with its supported revisions — and the legacy
// initialize handshake as well. Six tools mirror github-mcp-server's
// names and arguments, and every one acts on the same store the REST
// surface serves, so an object made over MCP reads back over REST
// unchanged.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, branchTip, readBody, squashMergePull } from './rest.ts';
import type { ForgeStore, RepoRec } from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (store: ForgeStore, args: Record<string, unknown>) => Record<string, unknown>;
}

function repoView(store: ForgeStore, repo: RepoRec): Record<string, unknown> {
  const owner = repo.ownerLogin ?? store.viewerLogin ?? 'adaiversen';
  return {
    id: store.repoIds.get(repo.name) ?? 0,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueView(repo: RepoRec, issue: { number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  void repo;
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function mustRepo(store: ForgeStore, args: Record<string, unknown>): RepoRec {
  const repo = store.resolve(String(args.owner ?? ''), String(args.repo ?? ''));
  if (repo === null) throw new Error(`repository ${String(args.owner)}/${String(args.repo)} not found`);
  return repo;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'A short description of the repository' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
    run: (store, args) => {
      const name = String(args.name ?? '');
      const existing = store.repos.get(name);
      if (existing !== undefined) return repoView(store, existing);
      const repo = store.createRepo(name, String(args.description ?? ''), args.private === true);
      return repoView(store, repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
    },
    required: ['owner', 'repo'],
    run: (store, args) => repoView(store, mustRepo(store, args)),
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
    required: ['owner', 'repo', 'title'],
    run: (store, args) => {
      const repo = mustRepo(store, args);
      const number = repo.nextNumber++;
      const issue = {
        number,
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
        state: 'open' as const,
        labels: [] as string[],
        comments: [],
        seq: repo.nextSeq++,
      };
      repo.issues.set(number, issue);
      return issueView(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'Filter by state: open, closed or all' },
    },
    required: ['owner', 'repo'],
    run: (store, args) => {
      const repo = mustRepo(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
      if (state !== 'all') list = list.filter((i) => i.state === state);
      return { issues: list.map((i) => issueView(repo, i)) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The pull request title' },
      body: { type: 'string', description: 'The pull request body' },
      head: { type: 'string', description: 'The head branch name' },
      base: { type: 'string', description: 'The base branch name' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (store, args) => {
      const repo = mustRepo(store, args);
      const headRef = String(args.head ?? '');
      const baseRef = String(args.base ?? '');
      const headSha = branchTip(repo, headRef);
      const baseSha = branchTip(repo, baseRef);
      if (headSha === null || baseSha === null) throw new Error('invalid head or base branch');
      const number = repo.nextNumber++;
      const pull = {
        number,
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
        state: 'open' as const,
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
      return {
        number,
        title: pull.title,
        body: pull.body,
        state: 'open',
        head: { ref: headRef, sha: headSha },
        base: { ref: baseRef, sha: baseSha },
      };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      pull_number: { type: 'number', description: 'The pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (store, args) => {
      const repo = mustRepo(store, args);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new Error(`pull request ${String(args.pull_number)} not found`);
      const { sha } = squashMergePull(store, repo, pull);
      return {
        number: pull.number,
        state: 'closed',
        merged: true,
        merge_commit_sha: sha,
        sha,
      };
    },
  },
];

const TOOL_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: {
    type: 'object',
    properties: tool.properties,
    required: tool.required,
  },
}));

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function dispatch(store: ForgeStore, request: JsonRpcRequest): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  // A message with no id is a notification: never answered.
  if (id === undefined) return null;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOL_LIST });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      for (const required of tool.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcError(id, -32602, `missing required argument: ${required}`);
        }
      }
      try {
        const structured = tool.run(store, args);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(structured) }],
          structuredContent: structured,
          isError: false,
        });
      } catch (err) {
        if (err instanceof HttpError) {
          return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
        return rpcResult(id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : 'tool failed' }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: ForgeStore): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rpcError(null, -32601, 'method not allowed')));
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => dispatch(store, (entry ?? {}) as JsonRpcRequest))
      .filter((answer) => answer !== null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answers));
    return;
  }
  const answer = dispatch(store, (parsed ?? {}) as JsonRpcRequest);
  if (answer === null) {
    // A notification: accepted, no body.
    res.writeHead(202);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(answer));
}
