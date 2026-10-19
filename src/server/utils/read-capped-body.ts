import type { Readable } from 'stream';

export class BodyTooLargeError extends Error {}

/** A request body read by hand (route config `bodyParser: false`), refused past `maxBytes`. */
export async function readCappedBody(req: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) throw new BodyTooLargeError('payload too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
