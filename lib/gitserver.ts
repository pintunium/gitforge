// Git smart HTTP: protocol v2 upload-pack (ls-refs and fetch), the
// v0 upload-pack fallback, and v0 receive-pack with report-status.
// The counterparty is the suite's in-process git client, which speaks
// exactly what the rules describe; objects move verbatim, pushes are
// fast-forward only, and a refused ref never blocks its neighbours.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  buildPack,
  isAncestor,
  parseCommit,
  parsePack,
  parseTag,
} from './gitstore.ts';
import { PKT_FLUSH, PktReader, pktLine, sidebandPack } from './pktline.ts';
import { HttpError, readBody } from './rest.ts';
import type { ForgeStore, RepoRec } from './store.ts';

const UPLOAD_CAPS_V0 =
  'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The commit a ref ultimately points at, peeling tag objects. */
function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth++) {
    const obj = repo.git.read(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------
// Advertisements

function advertiseUploadPack(res: ServerResponse, repo: RepoRec, v2: boolean): void {
  const parts: Buffer[] = [];
  if (v2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine('agent=forge/1.0\n'));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow filter\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(pktLine('# service=git-upload-pack\n'));
    parts.push(PKT_FLUSH);
    const refs = sortedRefs(repo);
    const head = headTarget(repo);
    const headTip = repo.refs.get(head);
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_CAPS_V0}\n`));
    } else {
      let first = true;
      if (headTip !== undefined) {
        parts.push(pktLine(`${headTip} HEAD\0${UPLOAD_CAPS_V0}\n`));
        first = false;
      }
      for (const [ref, oid] of refs) {
        parts.push(pktLine(first ? `${oid} ${ref}\0${UPLOAD_CAPS_V0}\n` : `${oid} ${ref}\n`));
        first = false;
        const peeled = peelToCommit(repo, oid);
        if (peeled !== null && peeled !== oid) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
    parts.push(PKT_FLUSH);
  }
  const body = Buffer.concat(parts);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': body.length });
  res.end(body);
}

function advertiseReceivePack(res: ServerResponse, repo: RepoRec): void {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    let first = true;
    for (const [ref, oid] of refs) {
      parts.push(pktLine(first ? `${oid} ${ref}\0${RECEIVE_CAPS}\n` : `${oid} ${ref}\n`));
      first = false;
    }
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'content-length': body.length });
  res.end(body);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function runLsRefs(res: ServerResponse, repo: RepoRec, args: LsRefsArgs): void {
  const head = headTarget(repo);
  const headTip = repo.refs.get(head);
  const matches = (name: string): boolean => {
    if (args.prefixes.length === 0) return true;
    return args.prefixes.some((p) => name.startsWith(p));
  };
  const lines: string[] = [];
  // HEAD goes first when unfiltered, or when a prefix matches the
  // name HEAD itself; a prefix over refs/heads/ does not pull it in.
  const headMatches = args.prefixes.length === 0 || args.prefixes.some((p) => 'HEAD'.startsWith(p));
  if (headMatches) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${args.symrefs ? ` symref-target:${head}` : ''}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${head}` : ''}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const body = Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenRelative: boolean;
  deepenSince: number | null;
  deepenNot: string | null;
  done: boolean;
}

interface FetchPlan {
  oids: string[];
  shallowLines: string[];
  unshallowLines: string[];
}

/**
 * Choose the objects a fetch delivers. Held objects are the closure
 * of the client's haves, truncated at its shallow boundary; delivery
 * is the wants' ancestry the client lacks, generation-limited when a
 * deepen was requested, with the new shallow boundary reported.
 */
export function planFetch(repo: RepoRec, args: FetchArgs): FetchPlan {
  const git = repo.git;
  const shallowSet = new Set(args.shallow.map((s) => s.toLowerCase()));
  const haveSet = new Set(args.haves.map((s) => s.toLowerCase()));
  const wants = args.wants.map((s) => s.toLowerCase());

  // The generation limit from the wants. A plain deepen names the
  // new total depth; deepen-relative adds to the depth the client
  // already holds, measured down to its shallow boundary.
  let depthLimit = args.deepen;
  if (args.deepen !== null && args.deepenRelative) {
    let current = 0;
    const seenDepth = new Set<string>();
    let frontierDepth: string[] = [...wants];
    let gen = 0;
    while (frontierDepth.length > 0 && gen < 100000) {
      gen += 1;
      const nextDepth: string[] = [];
      let hit = false;
      for (const oid of frontierDepth) {
        if (seenDepth.has(oid)) continue;
        seenDepth.add(oid);
        const obj = git.read(oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        if (shallowSet.has(oid)) {
          hit = true;
          continue;
        }
        for (const parent of parseCommit(obj.data).parents) nextDepth.push(parent);
      }
      if (hit) {
        current = gen;
        break;
      }
      frontierDepth = nextDepth;
    }
    depthLimit = args.deepen + current;
  }

  const treeClosure = (commitOid: string, into: Set<string>): void => {
    const addTree = (treeOid: string): void => {
      if (into.has(treeOid)) return;
      const obj = git.read(treeOid);
      if (obj === undefined || obj.type !== 'tree') return;
      into.add(treeOid);
      for (const entry of parseTreeEntries(obj.data)) {
        if (entry.mode === '160000') continue;
        if (entry.mode === '40000') addTree(entry.oid);
        else into.add(entry.oid);
      }
    };
    const obj = git.read(commitOid);
    if (obj !== undefined && obj.type === 'commit') addTree(parseCommit(obj.data).tree);
  };

  // What the client already holds.
  const held = new Set<string>();
  const heldCommits = new Set<string>();
  {
    const stack = [...haveSet];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (heldCommits.has(oid)) continue;
      const obj = git.read(oid);
      if (obj === undefined) continue;
      if (obj.type === 'tag') {
        held.add(oid);
        stack.push(parseTag(obj.data).object);
        continue;
      }
      if (obj.type !== 'commit') continue;
      heldCommits.add(oid);
      held.add(oid);
      treeClosure(oid, held);
      if (shallowSet.has(oid)) continue; // boundary: its parents are not held
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
  }

  // Distance (in generations) from the nearest want, for every commit
  // reachable from the wants without crossing the shallow boundary of
  // history the client cannot see below its own boundary commits.
  const distance = new Map<string, number>();
  const deliveredCommits: string[] = [];
  {
    let frontier: string[] = [];
    const seen = new Set<string>();
    for (const want of wants) {
      const obj = git.read(want);
      if (obj === undefined) continue;
      if (obj.type === 'tag') {
        if (!held.has(want)) deliveredCommits.push(want); // tag object itself, handled below
        const target = parseTag(obj.data).object;
        if (!seen.has(target)) {
          seen.add(target);
          frontier.push(target);
          distance.set(target, 1);
        }
      } else if (obj.type === 'commit') {
        if (!seen.has(want)) {
          seen.add(want);
          frontier.push(want);
          distance.set(want, 1);
        }
      }
    }
    // Tag objects among the wants are emitted separately; the commit
    // walk proceeds generation by generation.
    let generation = 0;
    const commitFrontier = [...frontier];
    let current = commitFrontier;
    while (current.length > 0) {
      generation += 1;
      const next: string[] = [];
      for (const oid of current) {
        const obj = git.read(oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        if (depthLimit !== null && generation > depthLimit) continue;
        if (args.deepenSince !== null) {
          const [, epoch] = commitEpoch(obj.data);
          if (epoch !== null && epoch <= args.deepenSince) continue;
        }
        if (!heldCommits.has(oid) && !deliveredCommits.includes(oid)) deliveredCommits.push(oid);
        if (shallowSet.has(oid) && args.deepen === null) continue; // do not descend past the client's boundary
        for (const parent of parseCommit(obj.data).parents) {
          if (!seen.has(parent)) {
            seen.add(parent);
            distance.set(parent, generation + 1);
            next.push(parent);
          }
        }
      }
      current = next;
    }
  }

  const delivered = new Set<string>();
  const oids: string[] = [];
  const emit = (oid: string): void => {
    if (delivered.has(oid) || held.has(oid)) return;
    if (git.read(oid) === undefined) return;
    delivered.add(oid);
    oids.push(oid);
  };
  const deliveredCommitSet = new Set<string>();
  for (const oid of deliveredCommits) {
    const obj = git.read(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      emit(oid);
      continue;
    }
    deliveredCommitSet.add(oid);
    emit(oid);
    const trees = new Set<string>();
    treeClosure(oid, trees);
    for (const treeOid of trees) emit(treeOid);
  }

  // The new shallow boundary: delivered commits with a parent that
  // was not delivered. A previously shallow commit whose parents all
  // arrived (delivered now, or held already) stops being shallow —
  // it need not itself be re-delivered for that to be true.
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  const inShallowContext = args.deepen !== null || args.shallow.length > 0;
  if (inShallowContext) {
    for (const oid of deliveredCommitSet) {
      const parents = parseCommit(git.read(oid)!.data).parents;
      if (parents.some((p) => !deliveredCommitSet.has(p) && !heldCommits.has(p))) shallowLines.push(oid);
    }
    for (const oid of shallowSet) {
      const obj = git.read(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length > 0 && parents.every((p) => deliveredCommitSet.has(p) || heldCommits.has(p))) {
        unshallowLines.push(oid);
      }
    }
  }
  void distance;
  return { oids, shallowLines, unshallowLines };
}

function commitEpoch(data: Buffer): [string, number | null] {
  const commit = parseCommit(data);
  const match = / (\d+) [+-]\d{4}$/.exec(commit.committer);
  return [commit.committer, match === null ? null : Number(match[1])];
}

import { parseTree as parseTreeEntriesRaw } from './gitstore.ts';

function parseTreeEntries(data: Buffer): { mode: string; name: string; oid: string }[] {
  return parseTreeEntriesRaw(data);
}

function fetchResponse(res: ServerResponse, repo: RepoRec, args: FetchArgs, v2: boolean): void {
  const plan = planFetch(repo, args);
  const pack = buildPack(repo.git, plan.oids);
  const parts: Buffer[] = [];
  if (v2) {
    // A fetch still negotiating (haves but no done) first gets its
    // acknowledgments; "ready" tells the client the pack sections
    // follow in this same response.
    if (!args.done) {
      parts.push(pktLine('acknowledgments\n'));
      let acked = false;
      for (const have of args.haves) {
        if (repo.git.read(have.toLowerCase()) !== undefined) {
          parts.push(pktLine(`ACK ${have.toLowerCase()}\n`));
          acked = true;
        }
      }
      if (!acked) parts.push(pktLine('NAK\n'));
      parts.push(pktLine('ready\n'));
      parts.push(Buffer.from('0001', 'ascii'));
    }
    if (plan.shallowLines.length > 0 || plan.unshallowLines.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(Buffer.from('0001', 'ascii'));
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(PKT_FLUSH);
  } else {
    for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktLine('NAK\n'));
    parts.push(...sidebandPack(pack));
    parts.push(PKT_FLUSH);
  }
  const body = Buffer.concat(parts);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Request handling

function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const reader = new PktReader(body);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (;;) {
    const pkt = reader.next();
    if (pkt === null || pkt.kind === 'flush') break;
    if (pkt.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      // agent= and object-format= lines are accepted and ignored.
    } else {
      args.push(line);
    }
  }
  return { command, args };
}

function lsRefsArgs(args: string[]): LsRefsArgs {
  const out: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const arg of args) {
    if (arg === 'peel') out.peel = true;
    else if (arg === 'symrefs') out.symrefs = true;
    else if (arg === 'unborn') out.unborn = true;
    else if (arg.startsWith('ref-prefix ')) out.prefixes.push(arg.slice('ref-prefix '.length));
  }
  return out;
}

function fetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenRelative: false, deepenSince: null, deepenNot: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.deepen = Number(arg.slice(7).trim());
    else if (arg === 'deepen-relative') out.deepenRelative = true;
    else if (arg.startsWith('deepen-since ')) out.deepenSince = Number(arg.slice(13).trim());
    else if (arg.startsWith('deepen-not ')) out.deepenNot = arg.slice(11).trim();
    else if (arg === 'done') out.done = true;
  }
  return out;
}

/** The v0 upload-pack request: wants, flush, haves, done. */
function parseV0Fetch(body: Buffer): FetchArgs {
  const reader = new PktReader(body);
  const out: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenRelative: false, deepenSince: null, deepenNot: null, done: false };
  for (;;) {
    const pkt = reader.next();
    if (pkt === null) break;
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    const [head, ...rest] = line.split(' ');
    if (head === 'want') out.wants.push(rest[0]!);
    else if (head === 'have') out.haves.push(rest[0]!);
    else if (head === 'shallow') out.shallow.push(rest[0]!);
    else if (head === 'deepen') out.deepen = Number(rest[0]);
    else if (head === 'deepen-relative') out.deepenRelative = true;
    else if (head === 'deepen-since') out.deepenSince = Number(rest[0]);
    else if (head === 'deepen-not') out.deepenNot = rest.join(' ');
    else if (head === 'done') out.done = true;
  }
  return out;
}

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  url: URL,
): Promise<void> {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
  if (match === null) throw new HttpError(404, 'Not Found');
  const owner = decodeURIComponent(match[1]!);
  const repoName = decodeURIComponent(match[2]!);
  const rest = match[3] ?? '';
  const repo = store.resolve(owner, repoName);
  if (repo === null) throw new HttpError(404, 'Not Found');
  const method = req.method ?? 'GET';

  if (rest === '/info/refs' && method === 'GET') {
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      advertiseUploadPack(res, repo, (req.headers['git-protocol'] ?? '') === 'version=2');
      return;
    }
    if (service === 'git-receive-pack') {
      advertiseReceivePack(res, repo);
      return;
    }
    throw new HttpError(400, 'Unknown service');
  }

  if (rest === '/git-upload-pack' && method === 'POST') {
    const raw = await readBody(req);
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (v2) {
      let parsed: { command: string; args: string[] };
      try {
        parsed = parseV2Command(raw);
      } catch {
        throw new HttpError(400, 'Malformed pkt-line stream');
      }
      if (parsed.command === 'ls-refs') {
        runLsRefs(res, repo, lsRefsArgs(parsed.args));
        return;
      }
      if (parsed.command === 'fetch') {
        fetchResponse(res, repo, fetchArgs(parsed.args), true);
        return;
      }
      throw new HttpError(400, 'Unknown command');
    }
    let args: FetchArgs;
    try {
      args = parseV0Fetch(raw);
    } catch {
      throw new HttpError(400, 'Malformed pkt-line stream');
    }
    fetchResponse(res, repo, args, false);
    return;
  }

  if (rest === '/git-receive-pack' && method === 'POST') {
    const raw = await readBody(req);
    runReceivePack(res, repo, raw);
    return;
  }

  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function runReceivePack(res: ServerResponse, repo: RepoRec, raw: Buffer): void {
  const reader = new PktReader(raw);
  const commands: RefCommand[] = [];
  let sideband = false;
  let reportStatus = false;
  try {
    for (;;) {
      const pkt = reader.next();
      if (pkt === null || pkt.kind === 'flush') break;
      if (pkt.kind !== 'data') continue;
      let line = pkt.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        const caps = line.slice(nul + 1);
        if (caps.includes('side-band-64k')) sideband = true;
        if (caps.includes('report-status')) reportStatus = true;
        line = line.slice(0, nul);
      }
      const parts = line.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0]!.toLowerCase(), newOid: parts[1]!.toLowerCase(), ref: parts.slice(2).join(' ') });
      }
    }
  } catch {
    throw new HttpError(400, 'Malformed pkt-line stream');
  }
  const pack = reader.rest();

  let unpackLine = 'unpack ok';
  if (pack.length > 0) {
    try {
      parsePack(repo.git, pack);
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'pack error'}`;
    }
  }

  const results: string[] = [];
  for (const cmd of commands) {
    if (unpackLine !== 'unpack ok') {
      results.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      repo.refs.delete(cmd.ref);
      results.push(`ok ${cmd.ref}`);
      continue;
    }
    const target = repo.git.read(cmd.newOid);
    if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
      results.push(`ng ${cmd.ref} unknown object`);
      continue;
    }
    if (cmd.oldOid !== ZERO_OID) {
      const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
      const oldCommit = peelToCommit(repo, cmd.oldOid);
      const newCommit = peelToCommit(repo, cmd.newOid);
      if (current !== cmd.oldOid || oldCommit === null || newCommit === null || !isAncestor(repo.git, oldCommit, newCommit)) {
        results.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push(`ok ${cmd.ref}`);
  }

  if (!reportStatus) {
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': 0 });
    res.end();
    return;
  }
  const inner = Buffer.concat([pktLine(`${unpackLine}\n`), ...results.map((r) => pktLine(`${r}\n`)), PKT_FLUSH]);
  let body: Buffer;
  if (sideband) {
    body = Buffer.concat([...sidebandPack(inner), PKT_FLUSH]);
  } else {
    body = inner;
  }
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': body.length });
  res.end(body);
}
