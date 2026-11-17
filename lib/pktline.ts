// pkt-line framing, the length-prefixed packet format the git wire
// protocol is built from: a 4-hex-digit length that includes its own
// 4 bytes, then the payload. "0000" is a flush, "0001" a delimiter,
// "0002" the response end. No packet may exceed 65520 bytes in all.

export const PKT_MAX = 65520;

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > PKT_MAX) throw new Error(`pkt-line too long: ${length}`);
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** A cursor over a received pkt-line stream. */
export class PktReader {
  private offset = 0;
  private buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** The next packet, or null when the stream is exhausted or truncated. */
  next(): Pkt | null {
    if (this.offset + 4 > this.buf.length) return null;
    const head = this.buf.toString('ascii', this.offset, this.offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length "${head}"`);
    const length = parseInt(head, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'response-end' };
    }
    if (length === 3) throw new Error('invalid pkt-line (0003)');
    if (length < 4 || this.offset + length > this.buf.length) return null;
    const payload = this.buf.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }

  /** Everything not yet consumed (a receive-pack's raw packfile tail). */
  rest(): Buffer {
    return this.buf.subarray(this.offset);
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }
}

/**
 * Frame pack bytes as sideband band-1 packets: each packet's payload
 * is one band byte plus a chunk of the pack, within the 65520 limit.
 */
export function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const chunkSize = PKT_MAX - 4 - 1;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}
