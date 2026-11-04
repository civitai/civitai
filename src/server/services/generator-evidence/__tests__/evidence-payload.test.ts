import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { readVerifiedEvidence } from '~/server/services/generator-evidence/evidence-payload';
import type { StoredEvidenceBlob } from '~/server/services/generator-evidence/preserve-blob';

/** Reading a preserved copy back for a send or a view. Bytes and keys are invented. */

const chunks = [Buffer.from('first chunk, '), Buffer.from('second chunk, '), Buffer.from('last')];
const whole = Buffer.concat(chunks);
const blob: StoredEvidenceBlob = {
  blobId: 'OUTPUT000000001.png',
  role: 'output',
  status: 'preserved',
  evidenceKey: 'generator-evidence/7/job/OUTPUT000000001.png',
  sha256: createHash('sha256').update(whole).digest('hex'),
  contentType: 'image/png',
};

async function* streamed(parts: Uint8Array[], failAfter = Infinity) {
  for (const [i, part] of parts.entries()) {
    if (i >= failAfter) throw new Error('connection reset');
    yield part;
  }
}

describe('readVerifiedEvidence', () => {
  it('returns every byte of a copy streamed in several chunks, once its hash matches', async () => {
    const read = await readVerifiedEvidence(blob, async () => ({ chunks: streamed(chunks) }));

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Buffer.from(await read.body.arrayBuffer()).equals(whole)).toBe(true);
    expect(read.body.type).toBe('image/png');
  });

  it('refuses a copy whose last chunk changed', async () => {
    const changed = [...chunks.slice(0, -1), Buffer.from('LAST')];

    const read = await readVerifiedEvidence(blob, async () => ({ chunks: streamed(changed) }));

    expect(read).toMatchObject({ ok: false, shaMismatch: true });
  });

  it('stops reading a copy that runs past the size it was recorded at', async () => {
    let pulled = 0;
    async function* counted() {
      for (const chunk of chunks) {
        pulled++;
        yield chunk;
      }
    }

    const read = await readVerifiedEvidence({ ...blob, bytes: chunks[0].length }, async () => ({
      chunks: counted(),
    }));

    expect(read).toMatchObject({ ok: false, shaMismatch: true });
    expect(pulled).toBe(2);
  });

  it('refuses a copy whose stream fails part way, as a failed read', async () => {
    const read = await readVerifiedEvidence(blob, async () => ({ chunks: streamed(chunks, 1) }));

    expect(read).toEqual({ ok: false, reason: 'read failed: connection reset' });
  });
});
