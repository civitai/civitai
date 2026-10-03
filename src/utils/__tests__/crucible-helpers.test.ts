import { describe, expect, it } from 'vitest';
import { CrucibleIngestionStatus, CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import {
  baseModelMakesMediaType,
  canSeeCrucibleEntryDetails,
  getCrucibleCountdown,
  getCrucibleManageActions,
  getCrucibleMinVotes,
  getCruciblePrizeAmount,
  getCrucibleRatingLabel,
  getCrucibleStatusBadge,
  getCrucibleTransactionDescription,
  getCrucibleUrl,
  getCrucibleEntriesCost,
  getCrucibleTotalPrizePool,
  getFreeEntriesLabel,
  isCrucibleFinalStretch,
  isFreeCrucibleEntry,
  parsePrizePositions,
  rankCrucibleEntries,
} from '~/utils/crucible-helpers';

describe('parsePrizePositions', () => {
  it('parses the object map the database actually stores', () => {
    expect(parsePrizePositions({ '1': 40, '2': 30, '3': 20, '4': 10 })).toEqual([
      { position: 1, percentage: 40 },
      { position: 2, percentage: 30 },
      { position: 3, percentage: 20 },
      { position: 4, percentage: 10 },
    ]);
  });

  it('still parses an array, so an older stored value is not dropped', () => {
    expect(
      parsePrizePositions([
        { position: 1, percentage: 60 },
        { position: 2, percentage: 40 },
      ])
    ).toEqual([
      { position: 1, percentage: 60 },
      { position: 2, percentage: 40 },
    ]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '{"1":50}'],
    ['a number', 50],
  ])('returns [] for %s rather than throwing', (_label, input) => {
    expect(parsePrizePositions(input)).toEqual([]);
  });

  it('drops positions that cannot pay out', () => {
    expect(
      parsePrizePositions({ '1': 100, '2': 0, '0': 25, '-1': 10, x: 5, '3': Number.NaN })
    ).toEqual([{ position: 1, percentage: 100 }]);
  });

  it('drops malformed array members without dropping the good ones', () => {
    expect(
      parsePrizePositions([
        { position: 1, percentage: 50 },
        { position: '2', percentage: 50 },
        null,
        { position: 3 },
      ])
    ).toEqual([{ position: 1, percentage: 50 }]);
  });
});

describe('getCrucibleRatingLabel', () => {
  it('reads nsfwLevel as a bitmask of accepted ratings', () => {
    // PG | PG-13 = 3. Treated as one ordered level, 3 fell under "<= 4" and read as "R".
    expect(getCrucibleRatingLabel(1 | 2)).toBe('PG / PG-13');
  });

  it('labels a single rating on its own', () => {
    expect(getCrucibleRatingLabel(1)).toBe('PG');
    expect(getCrucibleRatingLabel(4)).toBe('R');
  });
});

describe('getCrucibleUrl', () => {
  it('slugs the name after the id', () => {
    expect(getCrucibleUrl(21, 'Neon Arena!')).toBe('/crucibles/21/neon-arena');
  });

  it.each(['judge', 'Judge', 'JUDGE!!'])(
    'never produces the judging route for a crucible named %s',
    (name) => {
      expect(getCrucibleUrl(21, name)).toBe('/crucibles/21/judge-crucible');
    }
  );
});

describe('getCrucibleStatusBadge', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const hoursFromNow = (h: number) => new Date(now.getTime() + h * 60 * 60 * 1000);

  // A 7-day run, so its final stretch (the last 20%) is longer than the 24h cap.
  const sevenDayRun = (hoursLeft: number) => ({
    startAt: hoursFromNow(hoursLeft - 7 * 24),
    endAt: hoursFromNow(hoursLeft),
  });

  it.each([
    [48, 'Active'],
    [23, 'Ending soon'],
    [-1, 'Ended'],
  ])('labels an Active crucible ending in %ih as %s', (hours, label) => {
    expect(getCrucibleStatusBadge(CrucibleStatus.Active, sevenDayRun(hours), now).label).toBe(
      label
    );
  });

  it('keeps a 24h crucible Active until its final stretch', () => {
    const twentyFourHourRun = (hoursLeft: number) => ({
      startAt: hoursFromNow(hoursLeft - 24),
      endAt: hoursFromNow(hoursLeft),
    });
    expect(getCrucibleStatusBadge(CrucibleStatus.Active, twentyFourHourRun(23), now).label).toBe(
      'Active'
    );
    expect(getCrucibleStatusBadge(CrucibleStatus.Active, twentyFourHourRun(4), now).label).toBe(
      'Ending soon'
    );
  });

  it('ignores endAt once the crucible has left Active', () => {
    expect(getCrucibleStatusBadge(CrucibleStatus.Completed, sevenDayRun(-1), now).label).toBe(
      'Completed'
    );
  });
});

describe('getCruciblePrizeAmount', () => {
  const prizePositions = [
    { position: 1, percentage: 50 },
    { position: 2, percentage: 30 },
    { position: 3, percentage: 20 },
  ];
  const amounts = (entryCount: number, positions = prizePositions) =>
    [1, 2, 3].map((position) =>
      getCruciblePrizeAmount({
        position,
        prizePositions: positions,
        entryCount,
        totalPrizePool: 1000,
      })
    );

  it('pays each place its own share when every place is filled', () => {
    expect(amounts(10)).toEqual([500, 300, 200]);
  });

  it('hands an unfilled place to the winners pro rata', () => {
    expect(amounts(2)).toEqual([625, 375, 0]);
    expect(amounts(1)).toEqual([1000, 0, 0]);
  });

  it('splits evenly when every filled place is 0%, rather than paying NaN', () => {
    const backLoaded = [
      { position: 1, percentage: 0 },
      { position: 2, percentage: 0 },
      { position: 3, percentage: 100 },
    ];
    expect(amounts(2, backLoaded)).toEqual([500, 500, 0]);
  });

  it('leaves a split that never reached 100% short by the same remainder', () => {
    const short = [
      { position: 1, percentage: 60 },
      { position: 2, percentage: 20 },
    ];
    expect(amounts(2, short).slice(0, 2)).toEqual([600, 200]);
    expect(amounts(1, short)[0]).toBe(800);
  });
});

describe('getCrucibleMinVotes', () => {
  it('asks for 75% of the average votes per entry, rounded up', () => {
    // Average 14 → 10.5, and a vote count is whole, so 11.
    expect(getCrucibleMinVotes({ totalVotes: 56, entryCount: 4 })).toBe(11);
  });

  it('does not round an exact 75% up to the next vote', () => {
    // Average 12 → exactly 9.
    expect(getCrucibleMinVotes({ totalVotes: 48, entryCount: 4 })).toBe(9);
  });

  it('asks for nothing when nobody has voted or nobody has entered', () => {
    expect(getCrucibleMinVotes({ totalVotes: 0, entryCount: 5 })).toBe(0);
    expect(getCrucibleMinVotes({ totalVotes: 0, entryCount: 0 })).toBe(0);
  });
});

describe('isCrucibleFinalStretch', () => {
  const startAt = new Date('2026-10-01T00:00:00Z');
  const endAt = new Date('2026-10-02T00:00:00Z'); // 24h, so the last 20% is 4.8h
  const at = (iso: string) => isCrucibleFinalStretch({ startAt, endAt, now: new Date(iso) });

  it('is false while more than a fifth of the crucible is left', () => {
    expect(at('2026-10-01T19:00:00Z')).toBe(false);
  });

  it('is true inside the last fifth', () => {
    expect(at('2026-10-01T19:30:00Z')).toBe(true);
  });

  it('is false once the crucible has ended', () => {
    expect(at('2026-10-02T00:00:01Z')).toBe(false);
  });

  it('is false without both dates', () => {
    expect(isCrucibleFinalStretch({ startAt: null, endAt, now: new Date() })).toBe(false);
    expect(isCrucibleFinalStretch({ startAt, endAt: null, now: new Date() })).toBe(false);
  });
});

describe('rankCrucibleEntries', () => {
  const entry = (id: number, score: number, position: number | null) => ({ id, score, position });

  it('orders a completed crucible by its placings and leaves unplaced entries unranked, last', () => {
    const ranked = rankCrucibleEntries(
      [entry(1, 1560, null), entry(2, 1480, 2), entry(3, 1550, 1)],
      { completed: true }
    );

    expect(ranked.map((e) => [e.id, e.rank])).toEqual([
      [3, 1],
      [2, 2],
      [1, null],
    ]);
  });

  it('ranks a cancelled crucible by score, since nobody was placed', () => {
    const ranked = rankCrucibleEntries([entry(1, 1400, null), entry(2, 1600, null)], {
      completed: false,
    });

    expect(ranked.map((e) => [e.id, e.rank])).toEqual([
      [2, 1],
      [1, 2],
    ]);
  });
});

describe('getCrucibleManageActions', () => {
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  const actions = (
    status: CrucibleStatus,
    endAt: Date | null,
    who: { isCreator?: boolean; isModerator?: boolean }
  ) =>
    getCrucibleManageActions({
      status,
      endAt,
      isCreator: !!who.isCreator,
      isModerator: !!who.isModerator,
    });

  it('offers nothing once a running crucible is past its end, even before it is finalized', () => {
    expect(actions(CrucibleStatus.Active, past, { isModerator: true })).toEqual({
      canEdit: false,
      canCancel: false,
      canRemoveEntries: false,
    });
    expect(actions(CrucibleStatus.Active, past, { isCreator: true })).toEqual({
      canEdit: false,
      canCancel: false,
      canRemoveEntries: false,
    });
  });

  it('offers nothing on a completed crucible, moderators included', () => {
    expect(actions(CrucibleStatus.Completed, past, { isModerator: true })).toEqual({
      canEdit: false,
      canCancel: false,
      canRemoveEntries: false,
    });
  });

  it('lets a moderator edit, cancel and remove entries from a running crucible', () => {
    expect(actions(CrucibleStatus.Active, future, { isModerator: true })).toEqual({
      canEdit: true,
      canCancel: true,
      canRemoveEntries: true,
    });
  });

  it('lets the creator edit a running crucible but cancel only before it starts', () => {
    expect(actions(CrucibleStatus.Active, future, { isCreator: true })).toEqual({
      canEdit: true,
      canCancel: false,
      canRemoveEntries: false,
    });
    expect(actions(CrucibleStatus.Pending, future, { isCreator: true })).toEqual({
      canEdit: true,
      canCancel: true,
      canRemoveEntries: false,
    });
  });

  it('offers a stranger nothing', () => {
    expect(actions(CrucibleStatus.Active, future, {})).toEqual({
      canEdit: false,
      canCancel: false,
      canRemoveEntries: false,
    });
  });

  it('offers removing entries only while it runs, since an upcoming one has none', () => {
    expect(actions(CrucibleStatus.Pending, future, { isModerator: true }).canRemoveEntries).toBe(
      false
    );
  });
});

describe('getCrucibleCountdown', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const inHours = (h: number) => new Date(now.getTime() + h * 60 * 60 * 1000);
  const countdown = (status: CrucibleStatus, startAt: Date | null, endAt: Date | null) =>
    getCrucibleCountdown({ status, startAt, endAt, now });

  it('counts down to the start of an upcoming crucible', () => {
    expect(countdown(CrucibleStatus.Pending, inHours(45), inHours(69))).toEqual({
      label: 'Starts In',
      value: '1d 21h',
      at: inHours(45),
    });
  });

  it('says it is starting once an upcoming crucible is past its start but not yet opened', () => {
    expect(countdown(CrucibleStatus.Pending, inHours(-0.1), inHours(24))).toMatchObject({
      label: 'Starts In',
      value: 'Starting',
    });
  });

  it('counts down to the end of a running crucible', () => {
    expect(countdown(CrucibleStatus.Active, inHours(-5), inHours(2.5))).toEqual({
      label: 'Time Left',
      value: '2h 30m',
      at: inHours(2.5),
    });
  });

  it('says ended once past the end, finalized or not', () => {
    expect(countdown(CrucibleStatus.Active, inHours(-30), inHours(-1)).value).toBe('Ended');
    expect(countdown(CrucibleStatus.Completed, inHours(-30), inHours(-1)).value).toBe('Ended');
  });
});

describe('getCrucibleTransactionDescription', () => {
  const scanned = (name: string) => ({
    name,
    ingestion: CrucibleIngestionStatus.Scanned,
    textNsfw: false,
  });

  it('names the crucible after the transaction text', () => {
    expect(
      getCrucibleTransactionDescription('Crucible prize - 1st place', scanned('Liminal Stuff'))
    ).toBe('Crucible prize - 1st place: Liminal Stuff');
  });

  it.each([
    ['still under review', { ingestion: CrucibleIngestionStatus.Pending, textNsfw: false }],
    ['blocked by the scan', { ingestion: CrucibleIngestionStatus.Blocked, textNsfw: false }],
    ['flagged as adult text', { ingestion: CrucibleIngestionStatus.Scanned, textNsfw: true }],
  ])('leaves out a name %s', (_, scan) => {
    expect(
      getCrucibleTransactionDescription('Crucible prize - 1st place', { name: 'Bad Name', ...scan })
    ).toBe('Crucible prize - 1st place');
  });

  it('cuts a long name so the whole description fits in 100 characters', () => {
    const description = getCrucibleTransactionDescription(
      'Crucible entry fee refund - crucible cancelled',
      scanned('x'.repeat(100))
    );
    expect(description).toHaveLength(100);
    expect(description.endsWith('x…')).toBe(true);
  });

  it('keeps a name that fits exactly', () => {
    const text = 'Crucible entry fee';
    const name = 'y'.repeat(100 - text.length - 2);
    expect(getCrucibleTransactionDescription(text, scanned(name))).toBe(`${text}: ${name}`);
  });

  it('never splits an emoji when cutting', () => {
    const text = 'Crucible entry fee';
    const room = 100 - text.length - 2;
    const description = getCrucibleTransactionDescription(
      text,
      scanned(`${'z'.repeat(room - 2)}😀😀`)
    );
    expect(description.length).toBeLessThanOrEqual(100);
    expect(description).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('baseModelMakesMediaType', () => {
  it.each([
    ['SDXL 1.0', MediaType.image, true],
    ['SDXL 1.0', MediaType.video, false],
    ['MiniMax H3', MediaType.image, false],
    ['MiniMax H3', MediaType.video, true],
    ['Grok', MediaType.image, true],
    ['Grok', MediaType.video, true],
    ['Other', MediaType.video, true],
    ['Some Unknown Base', MediaType.video, true],
  ])('%s makes %s: %s', (baseModel, mediaType, expected) => {
    expect(baseModelMakesMediaType(baseModel, mediaType)).toBe(expected);
  });
});

describe('free entries', () => {
  it('the prize pool grows with paid entries only', () => {
    expect(
      getCrucibleTotalPrizePool({ entryFee: 100, paidEntryCount: 2, seededPrizePool: 500 })
    ).toBe(700);
  });

  it("a person's entries are free until they've used their free ones", () => {
    expect(isFreeCrucibleEntry({ entriesSoFar: 0, freeEntriesPerUser: 1 })).toBe(true);
    expect(isFreeCrucibleEntry({ entriesSoFar: 1, freeEntriesPerUser: 1 })).toBe(false);
    expect(isFreeCrucibleEntry({ entriesSoFar: 0, freeEntriesPerUser: 0 })).toBe(false);
  });

  it.each([
    ['nothing used, one selected', 0, 1, 0],
    ['nothing used, three selected: one free, two paid', 0, 3, 200],
    ['the free one used, two selected', 1, 2, 200],
    ['more used than free', 3, 1, 100],
  ])('charges for the paid ones only — %s', (_, entriesSoFar, count, cost) => {
    expect(
      getCrucibleEntriesCost({ entriesSoFar, count, freeEntriesPerUser: 1, entryFee: 100 })
    ).toBe(cost);
  });

  it('charges every entry when none are free', () => {
    expect(
      getCrucibleEntriesCost({ entriesSoFar: 0, count: 2, freeEntriesPerUser: 0, entryFee: 100 })
    ).toBe(200);
  });

  it.each([
    [0, 3, null],
    [1, 3, 'First entry free'],
    [2, 3, 'First 2 entries free'],
    [3, 3, 'Free to enter'],
  ])('labels %i free of %i as %s', (freeEntriesPerUser, entryLimit, label) => {
    expect(getFreeEntriesLabel({ freeEntriesPerUser, entryLimit })).toBe(label);
  });
});

describe('canSeeCrucibleEntryDetails', () => {
  const stranger = { isModerator: false, isOwnEntry: false };

  it.each([CrucibleStatus.Pending, CrucibleStatus.Active])(
    "hides other people's entries from a judge while %s",
    (status) => {
      expect(canSeeCrucibleEntryDetails({ status, ...stranger })).toBe(false);
    }
  );

  it.each([CrucibleStatus.Completed, CrucibleStatus.Cancelled])(
    'reveals every entry once %s',
    (status) => {
      expect(canSeeCrucibleEntryDetails({ status, ...stranger })).toBe(true);
    }
  );

  it('shows an entrant their own entries while running', () => {
    expect(
      canSeeCrucibleEntryDetails({
        status: CrucibleStatus.Active,
        isModerator: false,
        isOwnEntry: true,
      })
    ).toBe(true);
  });

  it('shows moderators every entry while running', () => {
    expect(
      canSeeCrucibleEntryDetails({
        status: CrucibleStatus.Active,
        isModerator: true,
        isOwnEntry: false,
      })
    ).toBe(true);
  });
});
