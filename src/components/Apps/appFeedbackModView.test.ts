import { describe, expect, it } from 'vitest';
import { modListAppFeedbackSchema } from '~/server/schema/app-feedback.schema';
import {
  APP_FEEDBACK_HIDE_CONFLICT_MESSAGE,
  APP_FEEDBACK_OWNER_STATUS_FILTER_OPTIONS,
  DEFAULT_APP_FEEDBACK_MOD_FILTERS,
  appFeedbackHideErrorView,
  appFeedbackModFiltersToQuery,
  parseAppFeedbackModFilters,
  toAppFeedbackModRowView,
  toModListInput,
  type AppFeedbackModFilters,
  type AppFeedbackModRow,
} from '~/components/Apps/appFeedbackModView';

describe('toModListInput', () => {
  it('sends no filter keys at the defaults', () => {
    expect(toModListInput(DEFAULT_APP_FEEDBACK_MOD_FILTERS)).toStrictEqual({
      limit: 50,
      hidden: 'all',
    });
  });

  it('maps each filter alone', () => {
    const base = DEFAULT_APP_FEEDBACK_MOD_FILTERS;
    expect(toModListInput({ ...base, appListingId: 'apl_A' })).toStrictEqual({
      limit: 50,
      hidden: 'all',
      appListingId: 'apl_A',
    });
    expect(toModListInput({ ...base, listingDeleted: true })).toStrictEqual({
      limit: 50,
      hidden: 'all',
      listingDeleted: true,
    });
    expect(toModListInput({ ...base, ownerStatus: 'new' })).toStrictEqual({
      limit: 50,
      hidden: 'all',
      ownerStatus: 'new',
    });
    expect(toModListInput({ ...base, flagged: true })).toStrictEqual({
      limit: 50,
      hidden: 'all',
      flagged: true,
    });
    expect(toModListInput({ ...base, hidden: 'hidden' })).toStrictEqual({
      limit: 50,
      hidden: 'hidden',
    });
  });

  it('combines filters, and "listing deleted" drops a listing id', () => {
    const filters: AppFeedbackModFilters = {
      appListingId: 'apl_B',
      listingDeleted: true,
      ownerStatus: 'wont_fix',
      flagged: true,
      hidden: 'visible',
    };
    expect(toModListInput(filters)).toStrictEqual({
      limit: 50,
      hidden: 'visible',
      listingDeleted: true,
      ownerStatus: 'wont_fix',
      flagged: true,
    });
  });

  it('every output parses against the procedure schema; `false` would not', () => {
    const outputs = [
      toModListInput(DEFAULT_APP_FEEDBACK_MOD_FILTERS),
      toModListInput({ ...DEFAULT_APP_FEEDBACK_MOD_FILTERS, flagged: true, listingDeleted: true }),
    ];
    for (const o of outputs) expect(modListAppFeedbackSchema.safeParse(o).success).toBe(true);
    // Negative control: the shape the mapper exists to avoid.
    expect(modListAppFeedbackSchema.safeParse({ flagged: false }).success).toBe(false);
    expect(modListAppFeedbackSchema.safeParse({ listingDeleted: false }).success).toBe(false);
  });
});

describe('filter query string', () => {
  it('reads every filter', () => {
    expect(
      parseAppFeedbackModFilters({
        tab: 'app-feedback',
        app: 'apl_C',
        ownerStatus: 'acknowledged',
        flagged: '1',
        hidden: 'hidden',
      })
    ).toStrictEqual({
      appListingId: 'apl_C',
      listingDeleted: false,
      ownerStatus: 'acknowledged',
      flagged: true,
      hidden: 'hidden',
    });
  });

  it('falls back to "no filter" on unknown values', () => {
    expect(
      parseAppFeedbackModFilters({
        app: 'x'.repeat(65),
        ownerStatus: 'reviewed',
        flagged: 'yes',
        hidden: 'nope',
        listingDeleted: 'true',
      })
    ).toStrictEqual(DEFAULT_APP_FEEDBACK_MOD_FILTERS);
  });

  it('accepts a listing id at the schema maximum, and reads the first of a repeated param', () => {
    expect(parseAppFeedbackModFilters({ app: 'x'.repeat(64) }).appListingId).toBe('x'.repeat(64));
    expect(parseAppFeedbackModFilters({ flagged: ['1', '0'], hidden: ['visible'] })).toMatchObject({
      flagged: true,
      hidden: 'visible',
    });
  });

  it('"listing deleted" wins over a listing id', () => {
    const f = parseAppFeedbackModFilters({ app: 'apl_D', listingDeleted: '1' });
    expect(f.appListingId).toBeNull();
    expect(f.listingDeleted).toBe(true);
  });

  it('"listing deleted" writes no listing id to the query', () => {
    expect(
      appFeedbackModFiltersToQuery({
        ...DEFAULT_APP_FEEDBACK_MOD_FILTERS,
        appListingId: 'apl_F',
        listingDeleted: true,
      })
    ).toMatchObject({ app: undefined, listingDeleted: '1' });
  });

  it('round-trips, and clears a default back to no param', () => {
    const filters: AppFeedbackModFilters = {
      appListingId: 'apl_E',
      listingDeleted: false,
      ownerStatus: 'resolved',
      flagged: true,
      hidden: 'visible',
    };
    const query = appFeedbackModFiltersToQuery(filters);
    expect(query).toStrictEqual({
      app: 'apl_E',
      listingDeleted: undefined,
      ownerStatus: 'resolved',
      flagged: '1',
      hidden: 'visible',
    });
    expect(parseAppFeedbackModFilters(query)).toStrictEqual(filters);
    expect(
      Object.values(appFeedbackModFiltersToQuery(DEFAULT_APP_FEEDBACK_MOD_FILTERS)).every(
        (v) => v === undefined
      )
    ).toBe(true);
  });
});

const ROW: AppFeedbackModRow = {
  id: 4101,
  status: 'reviewed',
  triageNote: 'host bridge timeout',
  appListingId: 'apl_live',
  appBlockVersion: '2.3.1',
  appBlockSha: 'deadbeefcafe',
  ownerStatus: 'acknowledged',
  ownerStatusAt: new Date('2026-10-02T03:04:05Z'),
  ownerStatusByUsername: 'collab-ed',
  ownerFlaggedAt: new Date('2026-10-03T00:00:00Z'),
  hiddenFromOwnerAt: null,
  hiddenByModeratorUsername: 'stale-mod',
  reporterId: 77,
  reporterUsername: 'reporter-r',
  reporterBanned: false,
  reporterMuted: false,
  appName: 'Pose Studio',
  appSlug: 'pose-studio',
  appOwnerId: 12,
  appOwnerUsername: 'owner-o',
  surface: 'slot',
  modelId: 9001,
};
const modUrl = (path: string) => `https://mod.example${path}`;

describe('toAppFeedbackModRowView', () => {
  it('shows the full moderator view of a live row', () => {
    expect(toAppFeedbackModRowView(ROW, modUrl)).toStrictEqual({
      listingDeleted: false,
      appLabel: 'Pose Studio',
      appHref: '/apps/store-preview/pose-studio',
      ownerLabel: 'owner-o',
      reporterLabel: 'reporter-r',
      reporterHref: '/user/reporter-r',
      reporterBanned: false,
      reporterMuted: false,
      versionLabel: 'v2.3.1 · deadbee',
      surfaceLabel: 'Model page slot',
      modelHref: '/models/9001',
      modelLabel: 'Model #9001',
      ownerStatusLabel: 'Acknowledged',
      ownerStatusBy: 'collab-ed',
      ownerStatusAt: new Date('2026-10-02T03:04:05Z'),
      flagged: true,
      hidden: false,
      // Only a hidden row names who hid it.
      hiddenBy: null,
      triageStatus: 'Reviewed',
      triageNote: 'host bridge timeout',
      triageHref: 'https://mod.example/feedback/4101',
      action: 'hide',
    });
  });

  it('marks a deleted listing, a banned reporter and a hidden row', () => {
    const view = toAppFeedbackModRowView(
      {
        ...ROW,
        appListingId: null,
        appName: null,
        appSlug: null,
        appOwnerId: null,
        appOwnerUsername: null,
        reporterBanned: true,
        reporterMuted: true,
        reporterUsername: null,
        hiddenFromOwnerAt: new Date('2026-10-04T00:00:00Z'),
        hiddenByModeratorUsername: 'mod-m',
        ownerStatus: null,
        ownerFlaggedAt: null,
        appBlockVersion: null,
        appBlockSha: null,
        surface: null,
        modelId: null,
      },
      modUrl
    );
    expect(view).toMatchObject({
      listingDeleted: true,
      appLabel: 'Listing deleted',
      appHref: null,
      ownerLabel: null,
      reporterLabel: '#77',
      reporterHref: null,
      reporterBanned: true,
      reporterMuted: true,
      versionLabel: null,
      surfaceLabel: null,
      modelHref: null,
      ownerStatusLabel: 'New',
      ownerStatusBy: null,
      ownerStatusAt: null,
      flagged: false,
      hidden: true,
      hiddenBy: 'mod-m',
      action: 'unhide',
    });
  });

  it('a deleted listing never links, even if a stale slug and name came back', () => {
    const view = toAppFeedbackModRowView({ ...ROW, appListingId: null }, modUrl);
    expect(view.appHref).toBeNull();
    expect(view.appLabel).toBe('Listing deleted');
  });

  it('falls back for a nameless app, an owner without a username and an unknown status', () => {
    const view = toAppFeedbackModRowView(
      { ...ROW, appName: null, appOwnerUsername: null, status: 'escalated' },
      modUrl
    );
    expect(view.appLabel).toBe('apl_live');
    expect(view.ownerLabel).toBe('#12');
    expect(view.triageStatus).toBe('escalated');
  });

  it("labels every developer status with the owner inbox's words, and an unknown one raw", () => {
    const label = (ownerStatus: string | null) =>
      toAppFeedbackModRowView({ ...ROW, ownerStatus }, modUrl).ownerStatusLabel;
    expect([null, 'acknowledged', 'resolved', 'wont_fix', 'archived'].map(label)).toEqual([
      'New',
      'Acknowledged',
      'Resolved',
      "Won't fix",
      'archived',
    ]);
  });
});

describe('APP_FEEDBACK_OWNER_STATUS_FILTER_OPTIONS', () => {
  it('offers New then each developer status, labelled as the owner inbox labels them', () => {
    expect(APP_FEEDBACK_OWNER_STATUS_FILTER_OPTIONS).toStrictEqual([
      { value: 'new', label: 'New' },
      { value: 'acknowledged', label: 'Acknowledged' },
      { value: 'resolved', label: 'Resolved' },
      { value: 'wont_fix', label: "Won't fix" },
    ]);
  });
});

describe('appFeedbackHideErrorView', () => {
  it('a CONFLICT refetches with the conflict copy', () => {
    expect(
      appFeedbackHideErrorView({ message: 'server text', data: { code: 'CONFLICT' } })
    ).toStrictEqual({ message: APP_FEEDBACK_HIDE_CONFLICT_MESSAGE, refetch: true });
  });

  it('anything else shows the server message and does not refetch', () => {
    expect(
      appFeedbackHideErrorView({ message: 'nope', data: { code: 'FORBIDDEN' } })
    ).toStrictEqual({ message: 'nope', refetch: false });
    expect(appFeedbackHideErrorView(null)).toStrictEqual({
      message: 'Something went wrong.',
      refetch: false,
    });
  });
});
