import type { Readable } from 'node:stream';

export class PayloadTooLarge extends Error {}

/**
 * Buffer a request body for signature checks, for routes that set `bodyParser: false`.
 *
 * Next's own 1 MB cap goes away with `bodyParser: false`, and the body is buffered BEFORE the
 * signature can be checked, so the limit has to be re-imposed here or any unauthenticated caller
 * can size the allocation. Throws `PayloadTooLarge` past `maxBytes`.
 */
export async function readRawBody(readable: Readable, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of readable) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > maxBytes) throw new PayloadTooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
