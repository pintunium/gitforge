// The GraphQL v4 surface at /api/graphql: a small lexer, parser and
// executor covering exactly the documents gh and github-mcp-server
// send — viewer, repository reads, issue and pull-request
// connections, the five mutations, Relay node(id:), __type
// introspection, and batched operations (a JSON array of documents
// answered in order). Global ids are opaque base64, stable across
// reads, and decode back to the object they name.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { branchTip, pullFiles, pullHasConflict, readBody, sendJson, squashMergePull } from './rest.ts';
import { trialNowIso, type ForgeStore, type IssueRec, type PullRec, type RepoRec } from './store.ts';

// ---------------------------------------------------------------------------
// Lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:=!$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      const text = input.slice(i, j);
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        const name = this.expectName();
        if (this.expectName() !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.expectName();
        fragments.set(name, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') throw new Error(`unexpected "${keyword}"`);
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.expectName();
      if (this.atPunct('(')) this.parseVariableDefinitions();
      // Directives are parsed and ignored.
      while (this.atPunct('@')) {
        this.next();
        this.expectName();
        if (this.atPunct('(')) this.parseArguments();
      }
      operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        this.parseValue();
      }
      while (this.atPunct('@')) {
        this.next();
        this.expectName();
        if (this.atPunct('(')) this.parseArguments();
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selection: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.tokens[this.pos] as { value?: string }).value !== 'on') {
          selection.push({ kind: 'spread', name: this.expectName() });
        } else {
          if (this.expectName() !== 'on') throw new Error('expected "on"');
          const typeCondition = this.expectName();
          selection.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.atPunct(':')) {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args = this.atPunct('(') ? this.parseArguments() : [];
      while (this.atPunct('@')) {
        this.next();
        this.expectName();
        if (this.atPunct('(')) this.parseArguments();
      }
      const sub = this.atPunct('{') ? this.parseSelectionSet() : null;
      selection.push({ kind: 'field', alias, name, args, selection: sub });
    }
    this.expectPunct('}');
    return selection;
  }
}

// ---------------------------------------------------------------------------
// Global ids

function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const split = text.indexOf(':');
    if (split === -1) return null;
    return { type: text.slice(0, split), key: text.slice(split + 1) };
  } catch {
    return null;
  }
}

function repoGlobalId(store: ForgeStore, repo: RepoRec): string {
  return globalId('Repository', String(store.repoIds.get(repo.name) ?? 0));
}

function issueGlobalId(store: ForgeStore, repo: RepoRec, issue: IssueRec): string {
  return globalId('Issue', `${store.repoIds.get(repo.name) ?? 0}:${issue.number}`);
}

function pullGlobalId(store: ForgeStore, repo: RepoRec, pull: PullRec): string {
  return globalId('PullRequest', `${store.repoIds.get(repo.name) ?? 0}:${pull.number}`);
}

function repoByDbId(store: ForgeStore, dbId: number): RepoRec | null {
  for (const [name, id] of store.repoIds) {
    if (id === dbId) return store.repos.get(name) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schema description for __type

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'INTERFACE';
  fields?: { name: string; type: string }[];
  enumValues?: string[];
  inputFields?: { name: string; type: string }[];
}

const SCHEMA: Record<string, TypeInfo> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: 'User' },
      { name: 'repository', type: 'Repository' },
      { name: 'node', type: 'Node' },
      { name: 'search', type: 'SearchResultItemConnection' },
      { name: 'user', type: 'User' },
      { name: 'organization', type: 'Organization' },
      { name: 'rateLimit', type: 'RateLimit' },
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: 'CreateIssuePayload' },
      { name: 'closeIssue', type: 'CloseIssuePayload' },
      { name: 'createPullRequest', type: 'CreatePullRequestPayload' },
      { name: 'mergePullRequest', type: 'MergePullRequestPayload' },
      { name: 'addComment', type: 'AddCommentPayload' },
    ],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'login', type: 'String' },
      { name: 'name', type: 'String' },
      { name: 'email', type: 'String' },
      { name: 'url', type: 'URI' },
      { name: 'avatarUrl', type: 'URI' },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'name', type: 'String' },
      { name: 'nameWithOwner', type: 'String' },
      { name: 'owner', type: 'RepositoryOwner' },
      { name: 'defaultBranchRef', type: 'Ref' },
      { name: 'viewerPermission', type: 'RepositoryPermission' },
      { name: 'hasIssuesEnabled', type: 'Boolean' },
      { name: 'hasProjectsEnabled', type: 'Boolean' },
      { name: 'hasWikiEnabled', type: 'Boolean' },
      { name: 'isPrivate', type: 'Boolean' },
      { name: 'isArchived', type: 'Boolean' },
      { name: 'description', type: 'String' },
      { name: 'url', type: 'URI' },
      { name: 'createdAt', type: 'DateTime' },
      { name: 'updatedAt', type: 'DateTime' },
      { name: 'pushedAt', type: 'DateTime' },
      { name: 'issue', type: 'Issue' },
      { name: 'issues', type: 'IssueConnection' },
      { name: 'pullRequest', type: 'PullRequest' },
      { name: 'pullRequests', type: 'PullRequestConnection' },
      { name: 'labels', type: 'LabelConnection' },
      { name: 'refs', type: 'RefConnection' },
      { name: 'stargazerCount', type: 'Int' },
      { name: 'forkCount', type: 'Int' },
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'IssueState' },
      { name: 'author', type: 'Actor' },
      { name: 'url', type: 'URI' },
      { name: 'createdAt', type: 'DateTime' },
      { name: 'updatedAt', type: 'DateTime' },
      { name: 'closedAt', type: 'DateTime' },
      { name: 'repository', type: 'Repository' },
      { name: 'comments', type: 'IssueCommentConnection' },
      { name: 'labels', type: 'LabelConnection' },
      { name: 'assignees', type: 'UserConnection' },
      { name: 'participants', type: 'UserConnection' },
      { name: 'reactions', type: 'ReactionConnection' },
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'PullRequestState' },
      { name: 'merged', type: 'Boolean' },
      { name: 'mergeable', type: 'MergeableState' },
      { name: 'headRefName', type: 'String' },
      { name: 'baseRefName', type: 'String' },
      { name: 'headRefOid', type: 'GitObjectID' },
      { name: 'baseRefOid', type: 'GitObjectID' },
      { name: 'headRef', type: 'Ref' },
      { name: 'baseRef', type: 'Ref' },
      { name: 'mergeCommit', type: 'Commit' },
      { name: 'files', type: 'PullRequestChangedFileConnection' },
      { name: 'author', type: 'Actor' },
      { name: 'url', type: 'URI' },
      { name: 'createdAt', type: 'DateTime' },
      { name: 'updatedAt', type: 'DateTime' },
      { name: 'mergedAt', type: 'DateTime' },
      { name: 'closedAt', type: 'DateTime' },
      { name: 'repository', type: 'Repository' },
      { name: 'commits', type: 'PullRequestCommitConnection' },
      { name: 'additions', type: 'Int' },
      { name: 'deletions', type: 'Int' },
      { name: 'changedFiles', type: 'Int' },
    ],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: [
      { name: 'path', type: 'String' },
      { name: 'additions', type: 'Int' },
      { name: 'deletions', type: 'Int' },
      { name: 'changeType', type: 'String' },
    ],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'body', type: 'String' },
      { name: 'author', type: 'Actor' },
      { name: 'url', type: 'URI' },
      { name: 'createdAt', type: 'DateTime' },
      { name: 'updatedAt', type: 'DateTime' },
    ],
  },
  Ref: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'name', type: 'String' },
      { name: 'prefix', type: 'String' },
      { name: 'target', type: 'GitObject' },
    ],
  },
  IssueConnection: { kind: 'OBJECT', fields: [{ name: 'nodes', type: 'Issue' }, { name: 'edges', type: 'IssueEdge' }, { name: 'pageInfo', type: 'PageInfo' }, { name: 'totalCount', type: 'Int' }] },
  PullRequestConnection: { kind: 'OBJECT', fields: [{ name: 'nodes', type: 'PullRequest' }, { name: 'edges', type: 'PullRequestEdge' }, { name: 'pageInfo', type: 'PageInfo' }, { name: 'totalCount', type: 'Int' }] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: [{ name: 'nodes', type: 'PullRequestChangedFile' }, { name: 'pageInfo', type: 'PageInfo' }, { name: 'totalCount', type: 'Int' }] },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: 'Boolean' },
      { name: 'hasPreviousPage', type: 'Boolean' },
      { name: 'startCursor', type: 'String' },
      { name: 'endCursor', type: 'String' },
    ],
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }, { name: 'clientMutationId', type: 'String' }] },
  CloseIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }, { name: 'clientMutationId', type: 'String' }] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }, { name: 'clientMutationId', type: 'String' }] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }, { name: 'clientMutationId', type: 'String' }] },
  AddCommentPayload: { kind: 'OBJECT', fields: [{ name: 'commentEdge', type: 'IssueCommentEdge' }, { name: 'subject', type: 'Node' }, { name: 'clientMutationId', type: 'String' }] },
  IssueCommentEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'IssueComment' }, { name: 'cursor', type: 'String' }] },
  Node: { kind: 'INTERFACE', fields: [{ name: 'id', type: 'ID' }] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrder: { kind: 'INPUT_OBJECT', inputFields: [{ name: 'field', type: 'IssueOrderField' }, { name: 'direction', type: 'OrderDirection' }] },
  CreateIssueInput: { kind: 'INPUT_OBJECT', inputFields: [{ name: 'repositoryId', type: 'ID' }, { name: 'title', type: 'String' }, { name: 'body', type: 'String' }] },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: [{ name: 'issueId', type: 'ID' }, { name: 'stateReason', type: 'IssueClosedStateReason' }] },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: [{ name: 'repositoryId', type: 'ID' }, { name: 'baseRefName', type: 'String' }, { name: 'headRefName', type: 'String' }, { name: 'title', type: 'String' }, { name: 'body', type: 'String' }] },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: [{ name: 'pullRequestId', type: 'ID' }, { name: 'mergeMethod', type: 'PullRequestMergeMethod' }] },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputFields: [{ name: 'subjectId', type: 'ID' }, { name: 'body', type: 'String' }] },
};

// ---------------------------------------------------------------------------
// Executor

/** A resolved object: its GraphQL type plus the resolver's source. */
interface GObj {
  type: string;
  source: unknown;
}

interface ExecCtx {
  store: ForgeStore;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
  errors: { message: string }[];
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return node.value;
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

function viewerLoginOf(store: ForgeStore): string {
  return store.viewerLogin ?? 'adaiversen';
}

function cursorFor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64url');
}

function offsetFor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

interface Connection<T> {
  items: T[];
  total: number;
  startOffset: number;
}

function page<T>(all: T[], args: Record<string, unknown>): Connection<T> {
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : all.length;
  const start = offsetFor(args.after);
  return { items: all.slice(start, start + first), total: all.length, startOffset: start };
}

function connectionObject<T>(conn: Connection<T>, wrap: (item: T) => GObj): GObj {
  return {
    type: 'Connection',
    source: {
      nodes: conn.items.map(wrap),
      pageInfo: {
        hasNextPage: conn.startOffset + conn.items.length < conn.total,
        hasPreviousPage: conn.startOffset > 0,
        startCursor: conn.items.length > 0 ? cursorFor(conn.startOffset + 1) : null,
        endCursor: conn.items.length > 0 ? cursorFor(conn.startOffset + conn.items.length) : null,
      },
      totalCount: conn.total,
    },
  };
}

type Resolver = (ctx: ExecCtx, source: never, args: Record<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => ({ type: 'User', source: { login: viewerLoginOf(ctx.store) } }) as GObj,
    repository: (ctx, _s, args) => {
      const repo = ctx.store.resolve(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : ({ type: 'Repository', source: repo }) as GObj;
    },
    node: (ctx, _s, args) => nodeById(ctx, String(args.id ?? '')),
    __type: (_ctx, _s, args) => {
      const name = String(args.name ?? '');
      return SCHEMA[name] === undefined ? null : ({ type: '__Type', source: { name, info: SCHEMA[name] } }) as GObj;
    },
    __schema: () => ({ type: '__Schema', source: {} }) as GObj,
  },
  Mutation: {
    createIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(ctx, String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('repository not found');
      const number = repo.nextNumber++;
      const issue: IssueRec = {
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        seq: repo.nextSeq++,
      };
      repo.issues.set(number, issue);
      return { type: 'CreateIssuePayload', source: { issue: { type: 'Issue', source: { repo, issue } } } } as GObj;
    },
    closeIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(ctx, String(input.issueId ?? ''));
      if (found === null) throw new Error('issue not found');
      found.issue.state = 'closed';
      return { type: 'CloseIssuePayload', source: { issue: { type: 'Issue', source: found } } } as GObj;
    },
    createPullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(ctx, String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('repository not found');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = branchTip(repo, headRef);
      const baseSha = branchTip(repo, baseRef);
      if (headSha === null || baseSha === null) throw new Error('invalid head or base branch');
      const number = repo.nextNumber++;
      const pull: PullRec = {
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
      return { type: 'CreatePullRequestPayload', source: { pullRequest: { type: 'PullRequest', source: { repo, pull } } } } as GObj;
    },
    mergePullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullFromGlobalId(ctx, String(input.pullRequestId ?? ''));
      if (found === null) throw new Error('pull request not found');
      squashMergePull(ctx.store, found.repo, found.pull);
      return { type: 'MergePullRequestPayload', source: { pullRequest: { type: 'PullRequest', source: found } } } as GObj;
    },
    addComment: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(ctx, String(input.subjectId ?? ''));
      if (found === null) throw new Error('subject not found');
      const comment = { id: found.repo.nextCommentId++, body: String(input.body ?? '') };
      found.issue.comments.push(comment);
      const node: GObj = { type: 'IssueComment', source: { repo: found.repo, issue: found.issue, comment } };
      return { type: 'AddCommentPayload', source: { commentEdge: { type: 'IssueCommentEdge', source: { node, cursor: cursorFor(comment.id) } } } } as GObj;
    },
  },
  User: {
    login: (_ctx, source) => (source as { login: string }).login,
    id: (ctx) => globalId('User', viewerLoginOf(ctx.store)),
    name: (ctx) => viewerLoginOf(ctx.store),
    email: (ctx) => `${viewerLoginOf(ctx.store)}@example.invalid`,
    url: () => '',
  },
  Repository: {
    id: (ctx, source) => repoGlobalId(ctx.store, source as RepoRec),
    databaseId: (ctx, source) => ctx.store.repoIds.get((source as RepoRec).name) ?? 0,
    name: (_ctx, source) => (source as RepoRec).name,
    nameWithOwner: (ctx, source) => `${(source as RepoRec).ownerLogin ?? viewerLoginOf(ctx.store)}/${(source as RepoRec).name}`,
    owner: (ctx, source) => ({ type: 'User', source: { login: (source as RepoRec).ownerLogin ?? viewerLoginOf(ctx.store) } }) as GObj,
    defaultBranchRef: (_ctx, source) => {
      const repo = source as RepoRec;
      if (!repo.refs.has(`refs/heads/${repo.defaultBranch}`)) return null;
      return { type: 'Ref', source: { name: repo.defaultBranch } } as GObj;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => true,
    hasWikiEnabled: () => true,
    isPrivate: (_ctx, source) => (source as RepoRec).isPrivate,
    isArchived: () => false,
    description: (_ctx, source) => (source as RepoRec).description,
    url: () => '',
    createdAt: () => trialNowIso(),
    updatedAt: () => trialNowIso(),
    pushedAt: () => trialNowIso(),
    stargazerCount: () => 0,
    forkCount: () => 0,
    issue: (_ctx, source, args) => {
      const repo = source as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : ({ type: 'Issue', source: { repo, issue } }) as GObj;
    },
    issues: (_ctx, source, args) => {
      const repo = source as RepoRec;
      let list = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      if (orderBy !== null && orderBy.direction === 'ASC') list.sort((a, b) => a.seq - b.seq);
      else if (orderBy !== null) list.sort((a, b) => b.seq - a.seq);
      else list.sort((a, b) => a.seq - b.seq); // connection default: creation order
      const conn = page(list, args);
      const connObj = connectionObject(conn, (issue) => ({ type: 'Issue', source: { repo, issue } }) as GObj);
      return { ...connObj, type: 'IssueConnection' };
    },
    pullRequest: (_ctx, source, args) => {
      const repo = source as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : ({ type: 'PullRequest', source: { repo, pull } }) as GObj;
    },
    pullRequests: (_ctx, source, args) => {
      const repo = source as RepoRec;
      const list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
      const conn = page(list, args);
      const connObj = connectionObject(conn, (pull) => ({ type: 'PullRequest', source: { repo, pull } }) as GObj);
      return { ...connObj, type: 'PullRequestConnection' };
    },
  },
  Issue: {
    id: (ctx, source) => issueGlobalId(ctx.store, (source as { repo: RepoRec }).repo, (source as { issue: IssueRec }).issue),
    number: (_ctx, source) => (source as { issue: IssueRec }).issue.number,
    title: (_ctx, source) => (source as { issue: IssueRec }).issue.title,
    body: (_ctx, source) => (source as { issue: IssueRec }).issue.body,
    state: (_ctx, source) => ((source as { issue: IssueRec }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    author: (ctx) => ({ type: 'User', source: { login: viewerLoginOf(ctx.store) } }) as GObj,
    url: () => '',
    createdAt: () => trialNowIso(),
    updatedAt: () => trialNowIso(),
    closedAt: (_ctx, source) => ((source as { issue: IssueRec }).issue.state === 'closed' ? trialNowIso() : null),
    repository: (_ctx, source) => ({ type: 'Repository', source: (source as { repo: RepoRec }).repo }) as GObj,
  },
  PullRequest: {
    id: (ctx, source) => pullGlobalId(ctx.store, (source as { repo: RepoRec }).repo, (source as { pull: PullRec }).pull),
    number: (_ctx, source) => (source as { pull: PullRec }).pull.number,
    title: (_ctx, source) => (source as { pull: PullRec }).pull.title,
    body: (_ctx, source) => (source as { pull: PullRec }).pull.body,
    state: (_ctx, source) => {
      const pull = (source as { pull: PullRec }).pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (_ctx, source) => (source as { pull: PullRec }).pull.merged,
    mergeable: (_ctx, source) => {
      const { repo, pull } = source as { repo: RepoRec; pull: PullRec };
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullHasConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (_ctx, source) => (source as { pull: PullRec }).pull.headRef,
    baseRefName: (_ctx, source) => (source as { pull: PullRec }).pull.baseRef,
    headRefOid: (_ctx, source) => branchTip((source as { repo: RepoRec }).repo, (source as { pull: PullRec }).pull.headRef) ?? (source as { pull: PullRec }).pull.headSha,
    baseRefOid: (_ctx, source) => branchTip((source as { repo: RepoRec }).repo, (source as { pull: PullRec }).pull.baseRef) ?? (source as { pull: PullRec }).pull.baseSha,
    author: (ctx) => ({ type: 'User', source: { login: viewerLoginOf(ctx.store) } }) as GObj,
    url: () => '',
    createdAt: () => trialNowIso(),
    updatedAt: () => trialNowIso(),
    mergedAt: (_ctx, source) => (source as { pull: PullRec }).pull.mergedAt,
    closedAt: (_ctx, source) => ((source as { pull: PullRec }).pull.state === 'closed' ? trialNowIso() : null),
    repository: (_ctx, source) => ({ type: 'Repository', source: (source as { repo: RepoRec }).repo }) as GObj,
    files: (_ctx, source, args) => {
      const { repo, pull } = source as { repo: RepoRec; pull: PullRec };
      const files = pullFiles(repo, pull).map((f) => ({
        path: String(f.filename),
        additions: Number(f.additions),
        deletions: Number(f.deletions),
        changeType: String(f.status).toUpperCase(),
      }));
      const conn = page(files, args);
      const connObj = connectionObject(conn, (file) => ({ type: 'PullRequestChangedFile', source: file }) as GObj);
      return { ...connObj, type: 'PullRequestChangedFileConnection' };
    },
    additions: (_ctx, source) => pullFiles((source as { repo: RepoRec }).repo, (source as { pull: PullRec }).pull).reduce((n, f) => n + Number(f.additions), 0),
    deletions: (_ctx, source) => pullFiles((source as { repo: RepoRec }).repo, (source as { pull: PullRec }).pull).reduce((n, f) => n + Number(f.deletions), 0),
    changedFiles: (_ctx, source) => pullFiles((source as { repo: RepoRec }).repo, (source as { pull: PullRec }).pull).length,
  },
  PullRequestChangedFile: {
    path: (_ctx, source) => (source as { path: string }).path,
    additions: (_ctx, source) => (source as { additions: number }).additions,
    deletions: (_ctx, source) => (source as { deletions: number }).deletions,
    changeType: (_ctx, source) => (source as { changeType: string }).changeType,
  },
  IssueComment: {
    id: (ctx, source) => {
      const s = source as { repo: RepoRec; issue: IssueRec; comment: { id: number } };
      return globalId('IssueComment', `${ctx.store.repoIds.get(s.repo.name) ?? 0}:${s.issue.number}:${s.comment.id}`);
    },
    body: (_ctx, source) => (source as { comment: { body: string } }).comment.body,
    author: (ctx) => ({ type: 'User', source: { login: viewerLoginOf(ctx.store) } }) as GObj,
    url: () => '',
    createdAt: () => trialNowIso(),
    updatedAt: () => trialNowIso(),
  },
  Ref: {
    name: (_ctx, source) => (source as { name: string }).name,
    prefix: () => 'refs/heads/',
    id: (_ctx, source) => globalId('Ref', (source as { name: string }).name),
  },
  Connection: {
    nodes: (_ctx, source) => (source as { nodes: GObj[] }).nodes,
    pageInfo: (_ctx, source) => ({ type: 'PageInfo', source: (source as { pageInfo: unknown }).pageInfo }) as GObj,
    totalCount: (_ctx, source) => (source as { totalCount: number }).totalCount,
  },
  PageInfo: {
    hasNextPage: (_ctx, source) => (source as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (_ctx, source) => (source as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (_ctx, source) => (source as { startCursor: string | null }).startCursor,
    endCursor: (_ctx, source) => (source as { endCursor: string | null }).endCursor,
  },
  CreateIssuePayload: {
    issue: (_ctx, source) => (source as { issue: GObj }).issue,
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (_ctx, source) => (source as { issue: GObj }).issue,
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, source) => (source as { pullRequest: GObj }).pullRequest,
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, source) => (source as { pullRequest: GObj }).pullRequest,
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (_ctx, source) => (source as { commentEdge: GObj }).commentEdge,
    clientMutationId: () => null,
  },
  IssueCommentEdge: {
    node: (_ctx, source) => (source as { node: GObj }).node,
    cursor: (_ctx, source) => (source as { cursor: string }).cursor,
  },
  __Type: {
    name: (_ctx, source) => (source as { name: string }).name,
    kind: (_ctx, source) => (source as { info: TypeInfo }).info.kind,
    description: () => null,
    fields: (_ctx, source) => {
      const info = (source as { info: TypeInfo }).info;
      if (info.fields === undefined) return null;
      return info.fields.map((f) => ({ type: '__Field', source: f }));
    },
    enumValues: (_ctx, source) => {
      const info = (source as { info: TypeInfo }).info;
      if (info.enumValues === undefined) return null;
      return info.enumValues.map((name) => ({ type: '__EnumValue', source: { name } }));
    },
    inputFields: (_ctx, source) => {
      const info = (source as { info: TypeInfo }).info;
      if (info.inputFields === undefined) return null;
      return info.inputFields.map((f) => ({ type: '__InputValue', source: f }));
    },
    possibleTypes: () => null,
    ofType: () => null,
    specifiedByURL: () => null,
    isOneOf: () => false,
  },
  __Field: {
    name: (_ctx, source) => (source as { name: string }).name,
    description: () => null,
    type: (_ctx, source) => {
      const typeName = (source as { type: string }).type;
      return { type: '__Type', source: { name: typeName, info: SCHEMA[typeName] ?? { kind: 'SCALAR' } } } as GObj;
    },
    args: () => [],
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (_ctx, source) => (source as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __InputValue: {
    name: (_ctx, source) => (source as { name: string }).name,
    description: () => null,
    type: (_ctx, source) => {
      const typeName = (source as { type: string }).type;
      return { type: '__Type', source: { name: typeName, info: SCHEMA[typeName] ?? { kind: 'SCALAR' } } } as GObj;
    },
    defaultValue: () => null,
  },
  __Schema: {
    types: () => Object.keys(SCHEMA).map((name) => ({ type: '__Type', source: { name, info: SCHEMA[name]! } })),
    queryType: () => ({ type: '__Type', source: { name: 'Query', info: SCHEMA.Query! } }) as GObj,
    mutationType: () => ({ type: '__Type', source: { name: 'Mutation', info: SCHEMA.Mutation! } }) as GObj,
    subscriptionType: () => null,
    directives: () => [],
  },
};

// The connection types resolve through the shared Connection entry.
RESOLVERS.IssueConnection = RESOLVERS.Connection!;
RESOLVERS.PullRequestConnection = RESOLVERS.Connection!;
RESOLVERS.PullRequestChangedFileConnection = RESOLVERS.Connection!;

function nodeById(ctx: ExecCtx, id: string): GObj | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = repoByDbId(ctx.store, Number(parsed.key));
    return repo === null ? null : { type: 'Repository', source: repo };
  }
  if (parsed.type === 'Issue') {
    const found = issueFromParsed(ctx, parsed.key);
    return found === null ? null : { type: 'Issue', source: found };
  }
  if (parsed.type === 'PullRequest') {
    const found = pullFromParsed(ctx, parsed.key);
    return found === null ? null : { type: 'PullRequest', source: found };
  }
  if (parsed.type === 'User') return { type: 'User', source: { login: viewerLoginOf(ctx.store) } };
  return null;
}

function repoFromGlobalId(ctx: ExecCtx, id: string): RepoRec | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  return repoByDbId(ctx.store, Number(parsed.key));
}

function issueFromParsed(ctx: ExecCtx, key: string): { repo: RepoRec; issue: IssueRec } | null {
  const [dbId, number] = key.split(':');
  const repo = repoByDbId(ctx.store, Number(dbId));
  if (repo === null) return null;
  const issue = repo.issues.get(Number(number));
  return issue === undefined ? null : { repo, issue };
}

function issueFromGlobalId(ctx: ExecCtx, id: string): { repo: RepoRec; issue: IssueRec } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return null;
  return issueFromParsed(ctx, parsed.key);
}

function pullFromParsed(ctx: ExecCtx, key: string): { repo: RepoRec; pull: PullRec } | null {
  const [dbId, number] = key.split(':');
  const repo = repoByDbId(ctx.store, Number(dbId));
  if (repo === null) return null;
  const pull = repo.pulls.get(Number(number));
  return pull === undefined ? null : { repo, pull };
}

function pullFromGlobalId(ctx: ExecCtx, id: string): { repo: RepoRec; pull: PullRec } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return null;
  return pullFromParsed(ctx, parsed.key);
}

function isGObj(value: unknown): value is GObj {
  return typeof value === 'object' && value !== null && 'type' in value && 'source' in value;
}

function executeSelection(ctx: ExecCtx, obj: GObj, selection: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeResolvers = RESOLVERS[obj.type] ?? {};
  for (const node of selection) {
    if (node.kind === 'inline') {
      if (node.typeCondition === obj.type || node.typeCondition === 'Node') {
        Object.assign(out, executeSelection(ctx, obj, node.selection));
      }
      continue;
    }
    if (node.kind === 'spread') {
      const fragment = ctx.fragments.get(node.name);
      if (fragment !== undefined && (fragment.typeCondition === obj.type || fragment.typeCondition === 'Node')) {
        Object.assign(out, executeSelection(ctx, obj, fragment.selection));
      }
      continue;
    }
    const key = node.alias ?? node.name;
    if (node.name === '__typename') {
      out[key] = obj.type;
      continue;
    }
    const resolver = typeResolvers[node.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field "${node.name}" does not exist on type "${obj.type}"` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = (resolver as (c: ExecCtx, s: never, a: Record<string, unknown>) => unknown)(ctx, obj.source as never, argsOf(node, ctx));
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'resolution failed' });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, node.selection);
  }
  return out;
}

function completeValue(ctx: ExecCtx, value: unknown, selection: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, selection));
  if (isGObj(value)) {
    if (selection === null) return value.source;
    return executeSelection(ctx, value, selection);
  }
  return value;
}

function executeOperation(store: ForgeStore, doc: DocumentNode, operationName: string | null, variables: Record<string, unknown>): Record<string, unknown> {
  const operation = doc.operations.find((op) => operationName === null || op.name === operationName) ?? doc.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = { store, variables, fragments: doc.fragments, errors: [] };
  const root: GObj = { type: operation.type === 'mutation' ? 'Mutation' : 'Query', source: {} };
  const data = executeSelection(ctx, root, operation.selection);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

// ---------------------------------------------------------------------------
// HTTP entry

interface GraphQLRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function runOne(store: ForgeStore, request: GraphQLRequest): Record<string, unknown> {
  if (typeof request.query !== 'string') return { errors: [{ message: 'query must be a string' }] };
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  try {
    const doc = new Parser(lex(request.query)).parseDocument();
    return executeOperation(store, doc, operationName, variables);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: ForgeStore): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Malformed JSON body' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => runOne(store, (entry ?? {}) as GraphQLRequest)));
    return;
  }
  sendJson(res, 200, runOne(store, (parsed ?? {}) as GraphQLRequest));
}
