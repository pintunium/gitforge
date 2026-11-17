// The git object store: content-addressed objects kept verbatim, pack
// reading and writing, and the commit/tree/blob helpers the forge's
// surfaces share. Pure Node standard library (node:crypto for SHA-1,
// node:zlib for compression). Objects are stored exactly as received
// or created — a pushed commit's bytes are never re-serialised, so a
// clone hands them back byte for byte.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export const ZERO_OID = '0'.repeat(40);

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a payload: SHA-1 over "<type> <length>\0" + data. */
export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/**
 * An in-memory object database. One per repository. Objects are
 * immutable; writing the same content twice is a no-op.
 */
export class ObjectStore {
  private objects = new Map<string, GitObject>();

  write(type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  put(oid: string, type: ObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  read(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get size(): number {
    return this.objects.size;
  }

  /** Every object id in the store (insertion order). */
  ids(): IterableIterator<string> {
    return this.objects.keys();
  }
}

// ---------------------------------------------------------------------------
// Commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object: repeated "<mode> <name>\0<20-byte oid>". */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: bytewise by name, directories as "name/". */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

// ---------------------------------------------------------------------------
// Packfiles

/**
 * Inflate one deflate stream out of `buf` starting at `offset`, where
 * the caller knows the inflated size the stream must produce. zlib's
 * sync inflate tolerates trailing bytes and reports no consumed
 * length, so the stream's end is found by binary search: the smallest
 * prefix that inflates to the full declared size is the stream (a
 * shorter prefix errors or inflates short — the final block's bytes
 * are always load-bearing). Returns the data and the offset just past
 * the stream.
 */
export function inflateEntry(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  let lo = offset + 1;
  let hi = buf.length;
  const probe = (end: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(offset, end));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  // Grow hi exponentially is unnecessary: binary search the whole tail.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (probe(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  const data = probe(lo);
  if (data === null) throw new Error('pack entry does not inflate to its declared size');
  return { data, next: lo };
}

export interface PackEntry {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

/**
 * Parse a packfile into the store. The suite's client sends only
 * plain (non-delta) entries; delta entries are rejected loudly rather
 * than silently misread. Verifies the SHA-1 trailer.
 */
export function parsePack(store: ObjectStore, pack: Buffer): PackEntry[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.toString('hex', pack.length - 20);
  if (sha1Hex(pack.subarray(0, pack.length - 20)) !== trailer) throw new Error('pack trailer checksum mismatch');
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6 || typeCode === 7) throw new Error('delta entries are not accepted in a received pack');
    const type = CODE_TYPES[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    const { data, next } = inflateEntry(pack, offset, size);
    offset = next;
    const oid = objectId(type, data);
    store.put(oid, type, data);
    entries.push({ oid, type, data });
  }
  return entries;
}

/** Serialise objects into a complete, self-contained packfile (no deltas). */
export function buildPack(store: ObjectStore, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = store.read(oid);
    if (obj === undefined) throw new Error(`cannot pack missing object ${oid}`);
    const typeCode = TYPE_CODES[obj.type];
    let size = obj.data.length;
    const first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    let byte = first;
    while (size > 0) {
      headBytes.push(byte | 0x80);
      byte = size & 0x7f;
      size >>= 7;
    }
    headBytes.push(byte);
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Reachability

/**
 * The closure of objects reachable from `tips`, newest commits first.
 * `exclude` holds object ids the peer already has: a commit in
 * `exclude` prunes its whole ancestry, and excluded trees/blobs are
 * left out. `depth` limits commit generations from the tips (1 = the
 * tips alone, with their trees and blobs); the commits at the depth
 * boundary are reported in `boundary`.
 */
export function collectObjects(
  store: ObjectStore,
  tips: string[],
  opts: { exclude?: Set<string>; depth?: number } = {},
): { oids: string[]; boundary: string[] } {
  const exclude = opts.exclude ?? new Set<string>();
  const depth = opts.depth ?? Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  const oids: string[] = [];
  const boundary: string[] = [];

  const addTree = (treeOid: string): void => {
    if (seen.has(treeOid) || exclude.has(treeOid)) return;
    const obj = store.read(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    seen.add(treeOid);
    oids.push(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '160000') continue; // gitlink: no object behind it
      if (entry.mode === '40000') addTree(entry.oid);
      else if (!seen.has(entry.oid) && !exclude.has(entry.oid)) {
        seen.add(entry.oid);
        oids.push(entry.oid);
      }
    }
  };

  // Breadth-first by generation so the depth boundary is exact.
  let frontier: string[] = [];
  const queued = new Set<string>();
  for (const tip of tips) {
    const obj = store.read(tip);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (!seen.has(tip) && !exclude.has(tip)) {
        seen.add(tip);
        oids.push(tip);
      }
      const target = parseTag(obj.data).object;
      if (!queued.has(target)) {
        queued.add(target);
        frontier.push(target);
      }
    } else if (obj.type === 'commit') {
      if (!queued.has(tip)) {
        queued.add(tip);
        frontier.push(tip);
      }
    }
  }
  let generation = 0;
  while (frontier.length > 0) {
    generation += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      if (exclude.has(oid)) continue; // the peer holds it: prune here
      const obj = store.read(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      if (!seen.has(oid)) {
        seen.add(oid);
        oids.push(oid);
      }
      const commit = parseCommit(obj.data);
      addTree(commit.tree);
      if (generation >= depth) {
        boundary.push(oid);
        continue;
      }
      for (const parent of commit.parents) {
        if (!queued.has(parent)) {
          queued.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return { oids, boundary };
}

/** True when `ancestor` is reachable from `descendant` through parents. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.read(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
  }
  return false;
}

/** The first common ancestor of two commits (breadth-first from `a`). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfB = new Set<string>();
  const stack = [b];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (ancestorsOfB.has(oid)) continue;
    ancestorsOfB.add(oid);
    const obj = store.read(oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
  }
  const seen = new Set<string>();
  const queue = [a];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfB.has(oid)) return oid;
    const obj = store.read(oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  return null;
}

/** Flatten a tree into a map of path -> {mode, oid}, recursively. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const obj = store.read(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [k, v] of flattenTree(store, entry.oid, path)) out.set(k, v);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** Build nested trees from a flat path -> blob map; returns the root tree oid. */
export function buildTreeFromFiles(store: ObjectStore, files: Map<string, { mode: string; oid: string }>): string {
  interface Dir {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1]!, file);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    return store.write('tree', buildTree(entries));
  };
  return build(root);
}
