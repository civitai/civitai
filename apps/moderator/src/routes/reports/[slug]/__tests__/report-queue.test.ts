import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import {
  DEFAULT_REPORT_REASONS,
  DEFAULT_REPORT_STATUSES,
  ReportReason,
  ReportStatus,
  reportReasons,
} from '$lib/reports';

/**
 * Filter resolution above `getReports` — where every recorded defect in this area has been: a filter
 * silently omitted, or a default set that drifted from what the queue badge counts.
 */

const getReports = vi.fn(async (_params: unknown) => ({
  items: [],
  totalItems: 0,
  page: 1,
  limit: 20,
}));

vi.mock('$lib/server/reports.service', () => ({
  getReports,
  setReportStatus: vi.fn(),
  updateReportNotes: vi.fn(),
}));
vi.mock('$lib/server/moderation-board.service', () => ({ getResolvedPostReportIds: vi.fn() }));
vi.mock('$lib/server/user-actions.service', () => ({ removePlacement: vi.fn() }));
vi.mock('$lib/server/access', () => ({ canAccess: vi.fn(() => true) }));

const { load } = await import('../+page.server');

/** `load` for one slug and query string. `redirect()`/`error()` throw, so callers that expect one catch. */
const run = (slug: string, query = '?status=Pending') =>
  load({ params: { slug }, url: new URL(`https://mod.example/reports/${slug}${query}`) } as never);

const caught = async (slug: string, query?: string) => {
  try {
    await run(slug, query);
  } catch (thrown) {
    return thrown;
  }
  throw new Error('expected load to throw');
};

/** The params `load` passed down to the service. */
const asked = () => getReports.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe('report queue load', () => {
  it('404s an unknown report type rather than querying for it', async () => {
    const thrown = await caught('not-a-report-type');

    expect(isHttpError(thrown)).toBe(true);
    expect((thrown as { status: number }).status).toBe(404);
    expect(getReports).not.toHaveBeenCalled();
  });

  it('canonicalizes a bare landing so the active default filters are in the URL', async () => {
    const thrown = await caught('image', '');

    expect(isRedirect(thrown)).toBe(true);
    const location = (thrown as { location: string }).location;
    const statuses = new URL(location, 'https://mod.example').searchParams.getAll('status');
    expect(statuses).toEqual(DEFAULT_REPORT_STATUSES);
    expect(getReports).not.toHaveBeenCalled();
  });

  it('reads a present-but-empty status as an explicit "all", not as absent', async () => {
    await run('image', '?status=');

    expect(asked().statuses).toBe('all');
  });

  it('reads a present-but-empty reason as an explicit "all", and stops hiding automated', async () => {
    const data = await run('image', '?status=Pending&reason=');

    expect(asked().reasons).toBe('all');
    expect(data).toMatchObject({ hidingAutomated: false });
  });

  it('hides automated reports by default — they outnumber human ones by orders of magnitude', async () => {
    const data = await run('image', '?status=Pending');

    expect(asked().reasons).toEqual(DEFAULT_REPORT_REASONS);
    expect(data).toMatchObject({ hidingAutomated: true });
  });

  it('does not echo the default reasons into the filter control', async () => {
    const data = await run('image', '?status=Pending');

    expect(data).toMatchObject({ reasons: [] });
  });

  it('drops values that are not real statuses or reasons instead of passing them to SQL', async () => {
    await run('image', '?status=Pending&status=Nope&reason=NSFW&reason=Nope');

    expect(asked().statuses).toEqual([ReportStatus.Pending]);
    expect(asked().reasons).toEqual([ReportReason.NSFW]);
  });

  it('passes page and reportedBy through, and floors a bad page at 1', async () => {
    await run('image', '?status=Pending&page=-4&reportedBy=%20alice%20');

    expect(asked()).toMatchObject({ page: 1, reportedBy: 'alice', type: 'image' });
  });
});

describe('the default reason set', () => {
  // Literals, NOT `reportReasons.filter(r => r !== Automated)` — that reproduces the definition in
  // `lib/reports.ts` character for character and so cannot fail. Narrowing this list once left
  // pending NSFW, CSAM and StickerPlacement reports behind a zero badge.
  it('carries every reason a human files, and excludes only Automated', () => {
    expect([...DEFAULT_REPORT_REASONS].sort()).toEqual([
      'AdminAttention',
      'CSAM',
      'Claim',
      'NSFW',
      'Ownership',
      'Spam',
      'StickerPlacement',
      'TOSViolation',
    ]);
  });

  // Derived on purpose: here the relationship to the enum IS the property.
  it('leaves no newly added reason silently unqueued', () => {
    expect([...DEFAULT_REPORT_REASONS].sort()).toEqual(
      reportReasons.filter((r) => r !== ReportReason.Automated).sort()
    );
  });
});
