import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';

/** Reads from the CSAM evidence bucket, against a fake S3 client. Keys and bytes are invented. */

const object = { chunks: [] as Buffer[], pulled: 0 };

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  class FakeS3Client {
    async send() {
      async function* body() {
        for (const chunk of object.chunks) {
          object.pulled++;
          yield chunk;
        }
      }
      return { Body: body(), ContentType: 'text/plain' };
    }
  }
  const mocked = { ...(await importOriginal<Record<string, unknown>>()), S3Client: FakeS3Client };
  return { ...mocked, default: mocked };
});

const { csamEvidenceStore } = await import('~/server/services/generator-evidence/evidence-store');

beforeEach(() => {
  object.chunks = Array.from({ length: 8 }, (_, i) => Buffer.alloc(4, 48 + i));
  object.pulled = 0;
  setEnv({
    CSAM_UPLOAD_KEY: 'test-key',
    CSAM_UPLOAD_SECRET: 'test-secret',
    CSAM_UPLOAD_REGION: 'test-region',
    CSAM_UPLOAD_ENDPOINT: 'https://example.invalid',
    CSAM_BUCKET_NAME: 'test-bucket',
  });
});

describe('csamEvidenceStore().read', () => {
  it('returns an object within the limit whole', async () => {
    const bytes = await csamEvidenceStore().read('manifest.jsonl', 32);

    expect(Buffer.from(bytes).equals(Buffer.concat(object.chunks))).toBe(true);
  });

  it('stops reading a longer object one byte past the limit', async () => {
    const bytes = await csamEvidenceStore().read('manifest.jsonl', 10);

    expect(bytes.length).toBe(11);
    expect(object.pulled).toBe(3);
  });
});
