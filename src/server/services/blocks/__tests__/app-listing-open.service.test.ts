import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ActionType } from '~/server/clickhouse/tracker';
import { trackActionSchema } from '~/server/schema/track.schema';

/**
 * `recordAppListingOpen` — the ONLY writer of the store's play count.
 *
 * Two properties are pinned here, and they fail in opposite directions:
 *
 *   1. it emits the right row (`App_Open`, carrying the block id and nothing else);
 *   2. it NEVER throws — a tracker outage must cost a slightly low number, not an app
 *      launch. The route calls it un-awaited, so a rejection here would surface as an
 *      unhandled rejection on the launch path rather than as anything a user could act on.
 *
 * The third property — that a browser cannot forge one of these rows — is asserted at the
 * bottom, against the real schema rather than against this module.
 */

const { mockAction, mockCtor } = vi.hoisted(() => ({
  mockAction: vi.fn<(...a: any[]) => Promise<boolean>>(),
  // 🔴 A SEPARATE CONSTRUCTOR SPY, AND IT IS NOT DECORATION. With `class { action = … }`
  // the constructor is empty and can never throw, so the "constructing the tracker throws"
  // case below was asserted by nothing — its throw came from `action`, the same call site
  // the async-rejection case already used. Measured: hoisting `new Tracker(…)` out of the
  // `try` (a plausible tidy-up) left all 13 tests green while a real constructor throw
  // would escape an un-awaited call, which on Node's default `--unhandled-rejections=throw`
  // exits the process on the app-launch path.
  //
  // It also records its ARGUMENTS, which nothing pinned either: deleting the third
  // (`session`) argument passed 42/42, silently reinstating the second `getServerAuthSession`
  // round trip on the critical path that the resolver's comment claims to avoid.
  mockCtor: vi.fn<(...a: any[]) => void>(),
}));

vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    constructor(...args: any[]) {
      mockCtor(...args);
    }
    action = mockAction;
  },
}));

// Imported AFTER the mock is declared (vi.mock is hoisted, so this is the mocked Tracker).
const { recordAppListingOpen } = await import('~/server/services/blocks/app-listing-open.service');

const CTX = { req: { headers: {} }, res: {} } as any;

describe('recordAppListingOpen', () => {
  beforeEach(() => {
    mockAction.mockReset();
    mockAction.mockResolvedValue(true);
    mockCtor.mockReset();
  });

  it('emits one App_Open carrying the block id', async () => {
    await recordAppListingOpen({ appBlockId: 'ab_42', session: null, ctx: CTX });

    expect(mockAction).toHaveBeenCalledTimes(1);
    expect(mockAction).toHaveBeenCalledWith({ type: 'App_Open', details: { appBlockId: 'ab_42' } });
  });

  it('puts NOTHING but ids in details — the column never carries author text', async () => {
    // `details` is a String column on a table with no TTL, so anything author-supplied that
    // reaches it outlives the listing it came from. The block id is a generated id; there is
    // no name, slug, tagline or URL in this payload, and this asserts the whole shape rather
    // than the presence of one key.
    await recordAppListingOpen({ appBlockId: 'ab_42', session: null, ctx: CTX });

    const details = mockAction.mock.calls[0][0].details;
    expect(Object.keys(details)).toEqual(['appBlockId']);
  });

  it('does not use skipActorMeta — a play is an interaction, not a private judgement', async () => {
    // Dropping ip/userAgent here would also drop the only signal the rollup can use to
    // collapse a refresh loop into one play, so the absence of that option is deliberate.
    await recordAppListingOpen({ appBlockId: 'ab_42', session: null, ctx: CTX });

    expect(mockAction.mock.calls[0][1]).toBeUndefined();
  });

  it('RESOLVES when the tracker rejects — a dead ClickHouse is not a failed launch', async () => {
    mockAction.mockRejectedValue(new Error('clickhouse unreachable'));

    await expect(
      recordAppListingOpen({ appBlockId: 'ab_42', session: null, ctx: CTX })
    ).resolves.toBeUndefined();
  });

  it('RESOLVES when the tracker throws SYNCHRONOUSLY from action()', async () => {
    // A sync throw takes a different path out of an `async` function than a rejected
    // promise, so both arms are needed: a `.catch()` chained onto the send would handle the
    // rejection and miss this one.
    mockAction.mockImplementation(() => {
      throw new Error('sync boom');
    });

    await expect(
      recordAppListingOpen({ appBlockId: 'ab_42', session: null, ctx: CTX })
    ).resolves.toBeUndefined();
  });

  it('RESOLVES when the tracker CONSTRUCTOR throws', async () => {
    // 🔴 THE CASE THAT USED TO BE VACUOUS. The construction must be INSIDE the try — moving
    // `new Tracker(…)` above it is a plausible refactor that reds nothing without this, and
    // it would let a constructor throw escape an un-awaited call, which Node's default
    // `--unhandled-rejections=throw` turns into a process exit on the app-launch path.
    mockCtor.mockImplementation(() => {
      throw new Error('ctor boom');
    });

    await expect(
      recordAppListingOpen({ appBlockId: 'ab_42', session: null, ctx: CTX })
    ).resolves.toBeUndefined();
    expect(mockAction).not.toHaveBeenCalled();
  });

  it('hands the Tracker the request, response AND the resolved session', async () => {
    // 🔴 THE THIRD ARGUMENT IS THE POINT. Omitting `session` leaves `sessionResolved` false,
    // so `Tracker.send` re-runs `getServerAuthSession` — a full JWE decrypt — on every
    // launch, which is exactly the cost the resolver's comment claims to avoid. Nothing
    // pinned it before: deleting the argument passed the whole suite.
    await recordAppListingOpen({ appBlockId: 'ab_42', session: null, ctx: CTX });

    expect(mockCtor).toHaveBeenCalledTimes(1);
    expect(mockCtor).toHaveBeenCalledWith(CTX.req, CTX.res, null);
  });

  it('App_Open is a real ActionType but has NO trackActionSchema arm', async () => {
    // 🔴 THE TRUSTED PROPERTY, and the one most likely to be undone by a well-meaning
    // "you forgot to add the schema arm" PR. `trackActionSchema` is what
    // `/api/track/batch` accepts from a browser; an arm here would let anyone POST plays
    // for any app, and this number is printed on a public store card.
    expect(ActionType).toContain('App_Open');

    const schemaTypes = trackActionSchema.options.map(
      (option: any) => option.shape.type.value as string
    );
    expect(schemaTypes).not.toContain('App_Open');
  });
});
