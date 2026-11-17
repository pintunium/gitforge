// The forge's HTTP server: one process serving git smart HTTP,
// REST v3, GraphQL v4 and MCP over a single shared store. Every API
// call carries the shop token as a Bearer credential; the token's
// owner is the only login that exists, and repositories addressed
// under any other owner are simply not found.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './lib/gitserver.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { HttpError, sendError, sendJson } from './lib/rest.ts';
import { handleRest } from './lib/rest.ts';
import { ForgeStore } from './lib/store.ts';

const store = new ForgeStore();

function authorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (token === undefined || token === '') return true; // local runs without a token
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;

  // The env's boot check: no auth, always the same answer.
  if (req.method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!authorized(req)) throw new HttpError(401, 'Bad credentials');

  if (path === '/api/graphql') {
    await handleGraphQL(req, res, store);
    return;
  }
  if (path === '/mcp') {
    await handleMcp(req, res, store);
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, store, url);
    return;
  }
  if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
    await handleGit(req, res, store, url);
    return;
  }
  throw new HttpError(404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    });
  });
}
