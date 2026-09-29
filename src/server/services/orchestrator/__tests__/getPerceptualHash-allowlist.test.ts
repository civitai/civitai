import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getPerceptualHash` URL allowlist.
 *
 * This funnel hands the orchestrator a caller-supplied media URL exactly like
 * `createImageIngestionRequest` does, and it is reached from a LOWER rung: the creator-shop
 * submit path (`queueCosmeticPerceptualHash`, any signed-in user with the `creatorShop`
 * flag), plus the `cosmetic-phash-sweep` cron which REPLAYS whatever landed in
 * `Cosmetic.data.url` — so one persisted off-allowlist URL is re-submitted on a schedule.
 *
 * 🔴 It returns `undefined` rather than throwing, unlike the ingestion funnel. That is
 * deliberate and is pinned below: every other failure in this function is already soft
 * ("a hash is a signal, not a gate"), and the sweep treats a throw as a dead row it retries.
 * A test that asserted `rejects` here would be pinning a behaviour we do not want.
 */

const { mockSubmitWorkflow } = vi.hoisted(() => ({ mockSubmitWorkflow: vi.fn() }));

vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflowWithRetry: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { IMAGE_INGESTION_IMAGE_SCANNING: 'image_ingestion_image_scanning' },
  isFlipt: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
// Pin the edge host — see the note in createImageIngestionRequest-allowlist.test.ts:
// @prisma/client dotenv-loads `<repo>/.env` at import, so an unpinned expectation depends on
// whether the checkout happens to have one.
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' },
}));
vi.mock('@civitai/client', () => ({
  submitWorkflow: mockSubmitWorkflow,
  WorkflowStatus: {},
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
}));
// 🔴 The logging client is deliberately NOT re-mocked here. It has a CANONICAL mock,
// registered once in src/__tests__/setup.ts, and `no-direct-shared-module-mock.test.ts` fails
// the build if a file declares its own — because under `isolate: false` a per-file mock
// freezes that file's shape into every later file sharing the worker. A hand-rolled one would
// also have stubbed out `safeError`, which this very service imports from the same module and
// legitimately runs.
//
// ⚠ That guard is TEXTUAL, so it matches the banned call shape even inside a comment. This
// note therefore describes it in prose rather than quoting it — a comment that spelled it out
// verbatim kept the file on the offender list after the real mock was already gone.

import { getPerceptualHash } from '~/server/services/orchestrator/orchestrator.service';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const EVIL_URL = 'https://evil.com/hash-me.png';
const STORAGE_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/name.png';

/**
 * 🔴 A DEFAULT resolution, not a bare reset — the same trap the sibling suite records. With
 * no default, `submitWorkflow` returns `undefined`, so deleting the guard would kill the test
 * on a destructure inside the try/catch, which then swallows it into `return undefined` — the
 * assertion would still pass and would be proving nothing. Resolving to an accusatory id
 * means a missing guard shows up as THAT id being returned.
 */
const allowSubmitByDefault = () =>
  mockSubmitWorkflow.mockReset().mockResolvedValue({
    data: {
      status: 'succeeded',
      steps: [{ status: 'succeeded', output: { hashes: { perceptual: 'MUSTNOTHAPPEN' } } }],
    },
  });

beforeEach(() => {
  // 🔴 `logToAxiom` is the SHARED canonical spy, so its calls accumulate across every test in
  // the worker unless cleared. Without this, the "logs the refusal" assertion below counted
  // this file's EARLIER refusals too and read `called 2 times`.
  vi.clearAllMocks();
  allowSubmitByDefault();
});

describe('getPerceptualHash URL allowlist', () => {
  it('returns undefined and submits NOTHING for an off-allowlist absolute URL', async () => {
    const result = await getPerceptualHash(EVIL_URL);

    expect(result).toBeUndefined();
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('logs the refusal, so a blocked hash is not a silent zero', async () => {
    await getPerceptualHash(EVIL_URL);

    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    const payload = loggingMock.logToAxiom.mock.calls[0][0];
    expect(payload).toMatchObject({ name: 'perceptual-hash', reason: 'url-not-allowed' });
    // The offending url rides along — this is what makes the follow-up gradeable.
    expect(payload.url).toBe(EVIL_URL);
  });

  it('refuses the slash-light spelling getEdgeUrl would forward as a relative key', async () => {
    // `http:/evil.com/x` is not matched by /^https?:\/\//, IS matched by startsWith('http'),
    // and WHATWG normalizes it back to an absolute URL at the fetch. The shared predicate is
    // what makes this a rejection rather than a "relative key".
    expect(await getPerceptualHash('http:/evil.com/x.png')).toBeUndefined();
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('hashes an allowed relative storage key, resolved onto the edge', async () => {
    mockSubmitWorkflow.mockResolvedValue({
      data: {
        status: 'succeeded',
        steps: [{ status: 'succeeded', output: { hashes: { perceptual: 'ABCD' } } }],
      },
    });

    const result = await getPerceptualHash(STORAGE_KEY);

    expect(result).toBe('abcd');
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    const mediaUrl = mockSubmitWorkflow.mock.calls[0][0].body.steps[0].input.mediaUrl;
    expect(mediaUrl.startsWith('https://image.test/')).toBe(true);
  });

  it('submits the NORMALIZED absolute url, so the fetcher resolves the host we validated', async () => {
    mockSubmitWorkflow.mockResolvedValue({
      data: {
        status: 'succeeded',
        steps: [{ status: 'succeeded', output: { hashes: { perceptual: 'BEEF' } } }],
      },
    });

    await getPerceptualHash('http:/image.civitai.com/a/b.png');

    const mediaUrl = mockSubmitWorkflow.mock.calls[0][0].body.steps[0].input.mediaUrl;
    // The parsed href, not the caller's spelling.
    expect(mediaUrl).toBe('http://image.civitai.com/a/b.png');
  });
});
