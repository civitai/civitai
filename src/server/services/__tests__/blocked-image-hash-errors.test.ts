import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';

// The ClickHouse wrapper rethrows a failed query with the whole query appended, which inlines the
// hash being looked up.
const { $query } = vi.hoisted(() => ({ $query: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query } }));

const { logToAxiom } = await import('~/server/logging/client');
const { BlocklistStoreError, getIsImageBlocked } = await import(
  '~/server/services/blocked-image-hash'
);
const { logPerceptualHashMatch } = await import('~/server/services/image-scan-pipeline');

// Past 2^53, so a match on its digits is unambiguous.
const PHASH = BigInt('-4276845791567733103');
const DIGITS = PHASH.toString().slice(1);

beforeEach(() => {
  setEnv({ BLOCKED_IMAGE_HASH_CHECK: true });
  vi.mocked(logToAxiom).mockClear();
  $query.mockReset();
  $query.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, part, i) => acc + part + (values[i] ?? ''), '');
    throw new Error(`ClickHouse query failed: socket hang up\nQuery: ${query}`);
  });
});

describe('getIsImageBlocked on a failed lookup', () => {
  it('throws a BlocklistStoreError that carries no hash', async () => {
    const thrown = await getIsImageBlocked(PHASH).then(
      () => expect.unreachable('the lookup reported a result'),
      (e: unknown) => e as Error
    );

    expect(thrown).toBeInstanceOf(BlocklistStoreError);
    expect(JSON.stringify([thrown.message, thrown.cause])).not.toContain(DIGITS);
  });

  it('answers when the lookup succeeds (control)', async () => {
    $query.mockResolvedValue([{ count: 1 }]);

    expect(await getIsImageBlocked(PHASH)).toBe(true);
  });
});

describe('the scan match log on a failed lookup', () => {
  it('logs the failure with no hash', async () => {
    await logPerceptualHashMatch({ imageId: 7, pHash: PHASH });

    expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'image-phash-match', type: 'warning', imageId: 7 }),
      'webhooks'
    );
    expect(JSON.stringify(vi.mocked(logToAxiom).mock.calls)).not.toContain(DIGITS);
  });
});
