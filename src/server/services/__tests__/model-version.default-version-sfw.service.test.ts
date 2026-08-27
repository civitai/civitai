import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';

/**
 * `getDefaultModelVersion` — which version a bare model link lands on.
 *
 * A version flagged NSFW by NAME is excluded from its model's rollup, so the model stays SFW
 * while that version is not. If the default picker ignores the flag, a bare link to a
 * perfectly safe model lands on the flagged version and redirects the whole page off the SFW
 * domain. Nothing errors and nothing else in the request notices.
 *
 * The other half is the substitution guard: an explicit `modelVersionId` must be answered with
 * THAT version even when it is flagged, so the page's own gate can redirect. Silently serving a
 * different version instead would be a wrong answer that looks like a right one.
 */

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));

const { getDefaultModelVersion } = await import('~/server/services/model-version.service');

const published = (id: number, nsfw: boolean) => ({
  id,
  status: 'Published',
  publishedAt: new Date('2020-01-01'),
  nsfw,
  model: { id: 3, userId: 99, availability: 'Public', status: 'Published' },
  availability: 'Public',
  trainingStatus: null,
});

const withVersions = (versions: ReturnType<typeof published>[]) =>
  dbMock.dbRead.model.findUnique.mockResolvedValue({ modelVersions: versions });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getDefaultModelVersion — SFW preference', () => {
  it('skips a flagged version for the first safe one', async () => {
    withVersions([published(1, true), published(2, false)]);

    const result = await getDefaultModelVersion({ modelId: 3, preferSfw: true });

    expect(result?.id).toBe(2);
  });

  it('keeps index order when the first version is not flagged', async () => {
    withVersions([published(1, false), published(2, false)]);

    const result = await getDefaultModelVersion({ modelId: 3, preferSfw: true });

    expect(result?.id).toBe(1);
  });

  // A preference, not a filter. With nothing safe to fall back to the page still has to render
  // something for its own gate to redirect — returning nothing here is a 404 for a model that
  // exists.
  it('still returns a flagged version when every version is flagged', async () => {
    withVersions([published(1, true), published(2, true)]);

    const result = await getDefaultModelVersion({ modelId: 3, preferSfw: true });

    expect(result?.id).toBe(1);
  });

  // The substitution guard. Answering "show me version 1" with version 2 hides the flagged
  // version rather than gating it, and the viewer is never told they got something else.
  //
  // The fixture needs a safe version to substitute TO, or the assertion holds for the broken code
  // as well — with only the flagged version present the preference finds nothing and falls through
  // to the same row either way.
  //
  // This pins the TypeScript guard only. In production the Prisma `where` already narrows to the
  // requested id, so the guard is defence in depth; the mock ignores `where`, so a revert that
  // relied on the query is not observable here.
  it('honours an explicit version id even when it is flagged', async () => {
    withVersions([published(1, true), published(2, false)]);

    const result = await getDefaultModelVersion({ modelId: 3, modelVersionId: 1, preferSfw: true });

    expect(result?.id).toBe(1);
  });

  it('ignores the flag entirely on the NSFW domain', async () => {
    withVersions([published(1, true), published(2, false)]);

    const result = await getDefaultModelVersion({ modelId: 3, preferSfw: false });

    expect(result?.id).toBe(1);
  });

  // The preference must not reach past the publication rules it sits behind: an unpublished
  // safe version is not a valid landing place just because it is safe.
  it('does not promote an unpublished safe version over a published flagged one', async () => {
    withVersions([
      published(1, true),
      { ...published(2, false), status: 'Draft' } as ReturnType<typeof published>,
    ]);

    const result = await getDefaultModelVersion({ modelId: 3, preferSfw: true });

    expect(result?.id).toBe(1);
  });
});
