import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `assertSafeMediaUrls` (training.service) reconciled onto the canonical lexical SSRF guard
 * `isPublicHttpsUrl` (`~/server/utils/ssrf-hostname`), replacing a LOCAL `PRIVATE_HOST_PATTERNS`
 * array that had drifted weaker than it.
 *
 * 🔴 WHAT THIS PINS, and what it deliberately does NOT claim. The drift was MEASURED against
 * the old array, not assumed: NINE shapes it admitted are refused now (the nine in
 * `admittedByTheOldArray` below). The three shapes it is tempting to also claim — integer,
 * hex and octal IPv4 literals — were ALREADY refused by the old array, because WHATWG
 * `new URL()` normalizes all three to hostname `127.0.0.1` before any denylist sees them.
 * They are pinned below under `alreadyRefusedBeforeThisChange` precisely so nobody
 * re-discovers them as "new coverage" — a test that counted them would be claiming credit for
 * behaviour that never changed.
 *
 * Watched RED against the old array: ALL NINE `admittedByTheOldArray` rows fail on
 * pre-change code (the old patterns match none of those hostnames); the
 * `alreadyRefusedBeforeThisChange` rows pass on BOTH sides and are invariant guards, labelled
 * as such rather than counted as regression coverage.
 *
 * The heavy training.service import graph is stubbed the same way
 * `training.orchestrator-error-mapping.test.ts` does it, so the module imports under node and
 * the REAL guard runs end-to-end.
 */

vi.mock('@civitai/client', () => ({
  handleError: vi.fn((e: unknown) => (typeof e === 'string' ? e : undefined)),
  submitWorkflow: vi.fn(),
}));
// `default` is required for the pre-bundled CJS interop; its absence shows up as a
// near-empty collect rather than a failure.
vi.mock('@aws-sdk/lib-storage', () => {
  const Upload = class {};
  return { Upload, default: { Upload } };
});
vi.mock('~/server/db/db-lag-helpers', () => ({ preventModelVersionLag: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: {} }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/schema/training.schema', () => ({ trainingServiceStatusSchema: {} }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/utils/s3-utils', () => ({
  deleteObject: vi.fn(),
  getB2S3Client: vi.fn(),
  getGetUrl: vi.fn(),
  getPutUrl: vi.fn(),
  getS3Client: vi.fn(),
  isB2Url: vi.fn(),
  parseKey: vi.fn(),
}));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({
  getOrchestratorCaller: vi.fn(),
}));

import { submitAutoLabelWorkflow } from '~/server/services/training.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const MODEL_ID = 991;
const USER_ID = 42;

/**
 * `assertSafeMediaUrls` runs AFTER `assertModelOwnership`, which reads the model. Resolve
 * ownership so the guard is the thing under test rather than the thing never reached.
 */
const ownModelAsTrained = () =>
  dbMock.dbRead.model.findUnique.mockResolvedValue({
    id: MODEL_ID,
    userId: USER_ID,
    deletedAt: null,
    uploadType: 'Trained',
  } as never);

const submit = (mediaUrl: string) =>
  submitAutoLabelWorkflow({
    userId: USER_ID,
    modelId: MODEL_ID,
    mediaType: 'image',
    images: [{ mediaUrl, filename: 'a.png' }],
    params: { type: 'tag' },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  ownModelAsTrained();
});

describe('assertSafeMediaUrls — the shapes the drifted local array ADMITTED', () => {
  /**
   * 🔴 THIS LIST WAS FOUR ROWS AND THE COUNT ROW PINNED `toHaveLength(4)`. Both were wrong:
   * the original differential only fed it the shapes its author imagined, so every
   * IPv6-embedding spelling went untested. Re-measured, the old array admitted NINE
   * private-space shapes. A count row makes the number a claim — so when adding to this
   * list, run the candidate through the differential; do not reason about it.
   */
  const admittedByTheOldArray: [string, string][] = [
    ['https://[::ffff:127.0.0.1]/x.png', 'IPv4-mapped IPv6 loopback'],
    ['https://[0:0:0:0:0:ffff:7f00:1]/x.png', 'the same, spelled out uncompressed'],
    ['https://[::ffff:169.254.169.254]/x.png', 'mapped cloud metadata'],
    ['https://[64:ff9b::a9fe:a9fe]/x.png', 'NAT64 prefix embedding 169.254.169.254'],
    ['https://[2002:7f00:1::]/x.png', '6to4 embedding 127.0.0.1'],
    ['https://[::]/x.png', 'unspecified address'],
    ['https://foo.internal/x.png', 'internal TLD'],
    ['https://foo.local/x.png', 'mDNS TLD'],
    ['https://metadata.google.internal/x.png', 'cloud metadata host'],
  ];

  it.each(admittedByTheOldArray)('refuses %s (%s)', async (url) => {
    await expect(submit(url)).rejects.toThrow('mediaUrl host is not reachable');
  });

  it('refuses ALL NINE — the count is the claim, so a shrinking set fails here', async () => {
    const refused: string[] = [];
    for (const [url] of admittedByTheOldArray) {
      await submit(url).then(
        () => undefined,
        (e: unknown) => {
          if (e instanceof Error && e.message.includes('not reachable')) refused.push(url);
        }
      );
    }
    expect(refused).toHaveLength(admittedByTheOldArray.length);
    expect(refused).toHaveLength(9);
  });
});

describe('assertSafeMediaUrls — INVARIANT guards (already refused before this change)', () => {
  /**
   * 🔴 Labelled invariant on purpose. These pass on pre-change code too, so they are NOT
   * regression coverage for this commit — they exist to stop a future "simplification" of
   * the guard from re-opening them, and to record WHY they were never bypasses.
   */
  const alreadyRefusedBeforeThisChange: [string, string][] = [
    ['https://2130706433/x.png', 'integer IPv4 — WHATWG normalizes to 127.0.0.1 pre-denylist'],
    ['https://0x7f000001/x.png', 'hex IPv4 — normalized the same way'],
    ['https://0177.0.0.1/x.png', 'octal dotted IPv4 — normalized the same way'],
    ['https://127.0.0.1/x.png', 'plain dotted loopback'],
    ['https://169.254.169.254/latest/meta-data/', 'cloud metadata by address'],
    ['https://10.0.0.5/x.png', 'RFC1918'],
    ['https://localhost/x.png', 'localhost'],
    ['http://image.civitai.com/x.png', 'http is not https'],
  ];

  it.each(alreadyRefusedBeforeThisChange)('refuses %s (%s)', async (url) => {
    await expect(submit(url)).rejects.toThrow(
      /mediaUrl host is not reachable|mediaUrl must be a plain HTTPS URL/
    );
  });

  it('refuses userinfo, which the canonical helper does NOT judge', async () => {
    // 🔴 This is the row that fails if someone "consolidates" by deleting the local
    // username/password check on the grounds that isPublicHttpsUrl covers the host. It does
    // not — it judges host SHAPE only, which is why safe-fetch.ts also checks userinfo
    // separately. `user@` before a host is the openly-spelled authority differential.
    await expect(submit('https://image.civitai.com@127.0.0.1/x.png')).rejects.toThrow(
      'mediaUrl must be a plain HTTPS URL'
    );
  });
});

describe('assertSafeMediaUrls — no false positive on the legitimate shape', () => {
  it('admits an ordinary public https media URL (reaches past the guard)', async () => {
    // Getting PAST the guard is the assertion: the call then fails downstream on the stubbed
    // orchestrator, which is a different error. A guard that rejected everything would pass a
    // rejects-based test, so this is the row that proves it is not doing that.
    const err = await submit('https://image.civitai.com/a/b.png').then(
      () => null,
      (e: unknown) => e
    );
    const message = err instanceof Error ? err.message : String(err ?? '');
    expect(message).not.toContain('mediaUrl host is not reachable');
    expect(message).not.toContain('mediaUrl must be a plain HTTPS URL');
  });
});
