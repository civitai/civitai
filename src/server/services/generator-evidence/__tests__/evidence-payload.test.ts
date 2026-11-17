import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  promptFileDetails,
  readVerifiedEvidence,
  trimEdgeSymbols,
} from '~/server/services/generator-evidence/evidence-payload';
import { trimNonAlphanumeric } from '~/utils/string-helpers';
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

const LIMIT = 1024;

async function* streamed(parts: Uint8Array[], failAfter = Infinity) {
  for (const [i, part] of parts.entries()) {
    if (i >= failAfter) throw new Error('connection reset');
    yield part;
  }
}

describe('readVerifiedEvidence', () => {
  it('returns every byte of a copy streamed in several chunks, once its hash matches', async () => {
    const read = await readVerifiedEvidence(
      blob,
      async () => ({ chunks: streamed(chunks) }),
      LIMIT
    );

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Buffer.from(await read.body.arrayBuffer()).equals(whole)).toBe(true);
    expect(read.body.type).toBe('image/png');
  });

  it('refuses a copy whose last chunk changed', async () => {
    const changed = [...chunks.slice(0, -1), Buffer.from('LAST')];

    const read = await readVerifiedEvidence(
      blob,
      async () => ({ chunks: streamed(changed) }),
      LIMIT
    );

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

    const read = await readVerifiedEvidence(
      { ...blob, bytes: chunks[0].length },
      async () => ({ chunks: counted() }),
      LIMIT
    );

    expect(read).toMatchObject({ ok: false, shaMismatch: true });
    expect(pulled).toBe(2);
  });

  it('stops reading a copy with no recorded size once it runs past the limit', async () => {
    let pulled = 0;
    async function* long() {
      for (let i = 0; i < 10; i++) {
        pulled++;
        yield chunks[0];
      }
    }

    const read = await readVerifiedEvidence(
      { ...blob, bytes: undefined },
      async () => ({ chunks: long() }),
      chunks[0].length * 3
    );

    expect(read).toMatchObject({ ok: false, overLimit: true });
    expect(pulled).toBe(4);
  });

  it('refuses a copy whose stream fails part way, as a failed read', async () => {
    const read = await readVerifiedEvidence(
      blob,
      async () => ({ chunks: streamed(chunks, 1) }),
      LIMIT
    );

    expect(read).toEqual({ ok: false, reason: 'read failed: connection reset' });
  });
});

describe('the EXIF trim', () => {
  // Word characters, symbols, whitespace, non-Latin text, an astral emoji and a lone surrogate.
  const alphabet = ['a', 'Z', '0', '_', '!', '<', ' ', '\n', '漢', '😀', '\uD800', '…'];

  it('returns what trimNonAlphanumeric returns, on every input tried', () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) >>> 16;
    const inputs = [
      undefined,
      '',
      '!!!',
      'abc',
      '  a  ',
      '😀',
      '!a!',
      '漢字 ok 漢字',
      '_',
      '!_x_!',
    ];
    for (let i = 0; i < 5_000; i++)
      inputs.push(
        Array.from({ length: next() % 12 }, () => alphabet[next() % alphabet.length]).join('')
      );

    for (const input of inputs) expect(trimEdgeSymbols(input)).toBe(trimNonAlphanumeric(input));
  });

  it('takes linear time on a generation prompt that is a long run of symbols', () => {
    const long = `a${'!'.repeat(200_000)}b`;

    const started = Date.now();
    const { details } = promptFileDetails({ prompt: long });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(details?.[0].valuePair[0].value).toBe(long);
  });
});
