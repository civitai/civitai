import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import {
  buildUsageLimitConfig,
  usageLimitDefs,
  usageLimits,
  type UsageLimitId,
} from '~/shared/constants/usage-limits';
import { resolveUsageLimitRules } from '~/server/services/usage-limit-config.service';
import { resolveUserAppLimit } from '~/server/services/blocks/user-app-caps.service';
import { rateLimitMetaOf } from '~/server/utils/rate-limit-error';
import { rateLimitMetaForRefusal, type RuleUsage } from '~/server/utils/rate-limit-window';
import { BLOCK_SUBMIT_RATE_LIMIT_MAX } from '~/server/utils/block-catalog-rate-limit';
import {
  FORK_RATE_LIMITED_MESSAGE,
  forkRateLimitedMessage,
} from '~/shared/constants/app-fork.constants';
import type { SessionUser } from '~/types/session';

/**
 * The App Platform's per-user caps as usage-limit registry entries (`app-usage-limits.ts`).
 *
 * DEFAULTS: every number below is a LITERAL, the limit each cap enforced before it had an entry.
 * With no KeyValue override the registry must serve exactly these, so moving a cap into the
 * registry changes nothing a user sees.
 */

type Pin = [window: string, base: number, kind: 'product' | 'abuse', reportsCounts: boolean];

// prettier-ignore
const DEFAULTS: Record<string, Pin> = {
  'apps.tip-daily':                  ['utc-day', 25_000, 'abuse', true],
  'apps.goods-daily':                ['utc-day', 150_000, 'abuse', true],
  'apps.fork-starts-hourly':         ['rolling:3600', 5, 'product', false],
  'apps.fork-starts-daily':          ['rolling:86400', 20, 'product', false],
  'apps.version-submits':            ['rolling:60', 10, 'product', false],
  'apps.media-upload-daily-items':   ['utc-day', 1200, 'product', false],
  'apps.media-upload-daily-bytes':   ['utc-day', 10_737_418_240, 'product', false],
  'apps.offsite-pending':            ['standing', 10, 'product', false],
  'apps.dev-tunnel-starts':          ['rolling:3600', 20, 'abuse', false],
  'apps.dev-token':                  ['rolling:60', 30, 'abuse', false],
  'apps.push-review':                ['rolling:3600', 20, 'abuse', false],
  'apps.listing-submissions':        ['rolling:60', 60, 'abuse', false],
  'apps.listing-withdrawals':        ['rolling:60', 30, 'abuse', false],
  'apps.generation-source':          ['rolling:3600', 60, 'abuse', false],
  'apps.submit-user':                ['rolling:10', 600, 'abuse', false],
  'apps.collaborator-invites':       ['rolling:3600', 30, 'abuse', false],
  'apps.collaborator-lookups':       ['rolling:3600', 600, 'abuse', false],
  'apps.ownership-transfers':        ['rolling:3600', 10, 'abuse', false],
  'apps.feedback':                   ['rolling:3600', 5, 'abuse', false],
  'apps.sleeping-reads':             ['rolling:3600', 60, 'abuse', false],
  'apps.sleeping-deletes':           ['rolling:3600', 60, 'abuse', false],
  'apps.storage-empties':            ['rolling:3600', 20, 'abuse', false],
  'apps.storage-exports':            ['rolling:3600', 120, 'abuse', false],
  'apps.listing-submits':            ['rolling:3600', 10, 'abuse', false],
  'apps.listing-edits':              ['rolling:3600', 30, 'abuse', false],
  'apps.listing-lookups':            ['rolling:60', 60, 'abuse', false],
  'apps.listing-revision-submits':   ['rolling:3600', 20, 'abuse', false],
  'apps.image-uploads':              ['rolling:3600', 60, 'abuse', false],
  'apps.listing-previews':           ['rolling:3600', 30, 'abuse', false],
  'apps.image-imports':              ['rolling:3600', 30, 'abuse', false],
  'apps.listing-reports':            ['rolling:3600', 20, 'abuse', false],
  'apps.listing-changes':            ['rolling:3600', 30, 'abuse', false],
  'apps.listing-visibility-changes': ['rolling:3600', 30, 'abuse', false],
  'apps.marketplace-reads':          ['rolling:60', 60, 'abuse', false],
  'apps.hidden-apps':                ['rolling:60', 60, 'abuse', false],
  'apps.review-submits':             ['rolling:60', 30, 'abuse', false],
  'apps.review-reads':               ['rolling:60', 60, 'abuse', false],
  'apps.generation-source-saves':    ['rolling:3600', 60, 'abuse', false],
  'apps.remix-submits':              ['rolling:3600', 20, 'abuse', false],
  'apps.remix-quotes':               ['rolling:60', 30, 'abuse', false],
  'apps.remix-team-quotes':          ['rolling:60', 120, 'abuse', false],
  'apps.remix-run-steps':            ['rolling:60', 30, 'abuse', false],
};

/** The 429 message each `rateLimit()` procedure answered with before it read the registry. */
const MESSAGES: Record<string, string | undefined> = {
  'apps.collaborator-invites': 'Too many collaborator invitations — slow down.',
  'apps.collaborator-lookups': 'Too many collaborator lookups — slow down.',
  'apps.ownership-transfers': 'Too many ownership transfer attempts — slow down.',
  'apps.feedback': 'You have submitted a lot of feedback — give it a little while.',
  'apps.sleeping-reads': undefined,
  'apps.sleeping-deletes': undefined,
  'apps.storage-empties': undefined,
  'apps.storage-exports': undefined,
  'apps.listing-submits': 'Too many submissions — slow down.',
  'apps.listing-edits': 'Too many edits — slow down.',
  'apps.listing-lookups': 'Too many listing lookups — slow down.',
  'apps.listing-revision-submits': 'Too many revision submissions — slow down.',
  'apps.image-uploads': 'Too many image uploads — slow down.',
  'apps.listing-previews': 'Too many preview lookups — slow down.',
  'apps.image-imports': 'Too many image imports — slow down.',
  'apps.listing-reports': 'Too many reports — slow down.',
  'apps.listing-changes': 'Too many listing changes — slow down.',
  'apps.listing-visibility-changes': 'Too many visibility changes — slow down.',
  'apps.marketplace-reads': 'Too many marketplace requests — slow down.',
  'apps.hidden-apps': 'Too many requests — slow down.',
  'apps.review-submits': 'Too many review submissions — slow down.',
  'apps.review-reads': 'Too many review requests — slow down.',
  'apps.generation-source-saves': 'Too many generation sources saved — slow down.',
  'apps.remix-submits': undefined,
  'apps.remix-quotes': undefined,
  'apps.remix-team-quotes': undefined,
  'apps.remix-run-steps': undefined,
};

const windowOf = (w: { type: string; seconds?: number }) =>
  w.type === 'rolling' ? `rolling:${w.seconds}` : w.type;

/** The entries added for the App Platform (the five storage/Buzz/sleeping caps predate them). */
const PREDATING = new Set([
  'apps.buzz-daily',
  'apps.storage-bytes',
  'apps.storage-docs',
  'apps.sleeping-count',
  'apps.sleeping-bytes',
]);

describe('the App Platform registry entries serve the limits enforced before them', () => {
  it('every entry, and only these, at its literal default', () => {
    const served = Object.fromEntries(
      usageLimitDefs
        .filter((def) => def.id.startsWith('apps.') && !PREDATING.has(def.id))
        .map((def) => [
          def.id,
          [windowOf(def.window), def.base, def.kind, 'reportsCounts' in def] as Pin,
        ])
    );
    expect(served).toEqual(DEFAULTS);
  });

  it('the owner-counted caps, and only these, cannot be counted by rateLimit()', () => {
    const owner = usageLimitDefs
      .filter((def) => 'countedBy' in def && def.countedBy === 'owner')
      .map((def) => def.id)
      .sort();
    expect(owner).toEqual(
      [
        'apps.dev-token',
        'apps.dev-tunnel-starts',
        'apps.fork-starts-daily',
        'apps.fork-starts-hourly',
        'apps.generation-source',
        'apps.goods-daily',
        'apps.listing-submissions',
        'apps.listing-withdrawals',
        'apps.media-upload-daily-bytes',
        'apps.media-upload-daily-items',
        'apps.offsite-pending',
        'apps.push-review',
        'apps.submit-user',
        'apps.tip-daily',
        'apps.version-submits',
      ].sort()
    );
    expect(() => usageLimits('apps.fork-starts-hourly')).toThrow(/enforcing service counts it/);
    expect(() => usageLimits('apps.marketplace-reads')).not.toThrow();
  });

  it('the fork refusal names the resolved limits, leaving out a disabled window', () => {
    expect(forkRateLimitedMessage(5, 20)).toBe(
      'You can start up to 5 forks an hour and 20 a day. Try again later.'
    );
    expect(FORK_RATE_LIMITED_MESSAGE).toBe(forkRateLimitedMessage(5, 20));
    expect(forkRateLimitedMessage(Number.POSITIVE_INFINITY, 20)).toBe(
      'You can start up to 20 forks a day. Try again later.'
    );
    expect(forkRateLimitedMessage(5, Number.POSITIVE_INFINITY)).toBe(
      'You can start up to 5 forks an hour. Try again later.'
    );
  });

  it('the per-user submit cap stays twice the per-install ceiling', () => {
    expect(DEFAULTS['apps.submit-user'][1]).toBe(2 * BLOCK_SUBMIT_RATE_LIMIT_MAX);
  });

  it('each rateLimit() procedure resolves to the same limit, window and 429 message as before', async () => {
    for (const [id, message] of Object.entries(MESSAGES)) {
      const [window, base] = DEFAULTS[id];
      const rules = await resolveUsageLimitRules(
        usageLimits(id as UsageLimitId).usageLimitIds,
        undefined
      );
      expect(rules, id).toEqual([
        {
          id,
          kind: 'abuse',
          limit: base,
          period: Number(window.split(':')[1]),
          errorMessage: message,
        },
      ]);
    }
  });
});

describe('abuse but reporting counts: the tip and goods daily caps', () => {
  it.each(['apps.tip-daily', 'apps.goods-daily'])(
    '%s: an override may move it but never disable it',
    (id) => {
      const off = buildUsageLimitConfig({ version: 1, limits: { [id]: { disabled: true } } });
      expect(off.fallbacks).toEqual([{ id, reason: 'only a product limit can be disabled' }]);
      expect(off.config.get(id)?.disabled).toBeUndefined();
      const moved = buildUsageLimitConfig({ version: 1, limits: { [id]: { base: 100 } } });
      expect(moved.fallbacks).toEqual([]);
      expect(moved.config.get(id)?.base).toBe(100);
    }
  );

  it('CONTROL: a product cap (fork starts) can be disabled, and is then not enforced', async () => {
    const { config, fallbacks } = buildUsageLimitConfig({
      version: 1,
      limits: { 'apps.fork-starts-hourly': { disabled: true } },
    });
    expect(fallbacks).toEqual([]);
    expect(
      await resolveUserAppLimit('apps.fork-starts-hourly', null, { getConfig: async () => config })
    ).toBe(Number.POSITIVE_INFINITY);
  });

  const COUNTS = {
    retryAfterSeconds: 60,
    retryAt: '2030-01-01T00:01:00.000Z',
    limit: 25_000,
    used: 25_000,
    remaining: 0,
    windowSeconds: 86_400,
    resetAt: '2030-01-02T00:00:00.000Z',
  };
  const refusal = (rateLimit: Record<string, unknown>) =>
    new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'x', cause: { rateLimit } });

  it('the tRPC strip keeps the counts of an abuse cap marked reportsCounts', () => {
    expect(rateLimitMetaOf(refusal({ ...COUNTS, id: 'apps.tip-daily', kind: 'abuse' }))).toEqual({
      ...COUNTS,
      id: 'apps.tip-daily',
      kind: 'abuse',
    });
  });

  it('other abuse limits still have their counts stripped, whatever kind the meta claims', () => {
    const bare = { retryAfterSeconds: 60, retryAt: COUNTS.retryAt };
    expect(rateLimitMetaOf(refusal({ ...COUNTS, id: 'apps.dev-token', kind: 'abuse' }))).toEqual({
      ...bare,
      id: 'apps.dev-token',
      kind: 'abuse',
    });
    // A registry abuse entry labelled `product` by its writer: the registry decides.
    expect(
      rateLimitMetaOf(refusal({ ...COUNTS, id: 'apps.marketplace-reads', kind: 'product' }))
    ).toEqual({ ...bare, id: 'apps.marketplace-reads', kind: 'product' });
    // Not a registry entry: the meta's own kind decides, as before.
    expect(rateLimitMetaOf(refusal({ ...COUNTS, id: 'apps.catalog', kind: 'abuse' }))).toEqual({
      ...bare,
      id: 'apps.catalog',
      kind: 'abuse',
    });
  });

  it('a rateLimit() rule marked reportsCounts refuses with its counts and kind abuse', () => {
    const now = Date.parse('2030-01-01T00:00:00.000Z');
    const usage = (reportsCounts: boolean): RuleUsage[] => [
      {
        rule: { id: 'x', kind: 'abuse', reportsCounts, limit: 2, period: 60 },
        used: 2,
        remaining: 0,
        refused: true,
        nextAt: now + 30_000,
        resetAt: now + 60_000,
      },
    ];
    expect(rateLimitMetaForRefusal(usage(true), now)).toEqual({
      retryAfterSeconds: 30,
      retryAt: '2030-01-01T00:00:30.000Z',
      id: 'x',
      kind: 'abuse',
      limit: 2,
      used: 2,
      remaining: 0,
      windowSeconds: 60,
      resetAt: '2030-01-01T00:01:00.000Z',
    });
    expect(rateLimitMetaForRefusal(usage(false), now)).toEqual({
      retryAfterSeconds: 30,
      retryAt: '2030-01-01T00:00:30.000Z',
      id: 'x',
      kind: 'abuse',
    });
  });
});

describe('resolveUserAppLimit: what an enforcing service reads', () => {
  const withRow = (limits: Record<string, unknown>) => {
    const { config, fallbacks } = buildUsageLimitConfig({ version: 1, limits });
    expect(fallbacks).toEqual([]);
    return { getConfig: async () => config };
  };
  const gold = { id: 9, tier: 'gold' } as SessionUser;

  it('serves the code default with no override, without reading the user', async () => {
    const getSessionUser = async () => {
      throw new Error('not read');
    };
    expect(
      await resolveUserAppLimit('apps.tip-daily', 9, {
        getConfig: async () => buildUsageLimitConfig(undefined).config,
        getSessionUser,
      })
    ).toBe(25_000);
  });

  it('a KeyValue override changes the enforced limit', async () => {
    expect(
      await resolveUserAppLimit('apps.tip-daily', 9, withRow({ 'apps.tip-daily': { base: 500 } }))
    ).toBe(500);
  });

  it('a tier override reads the user: the session user given, or the session read by id', async () => {
    const deps = withRow({ 'apps.fork-starts-daily': { byTier: { gold: { limit: 40 } } } });
    expect(await resolveUserAppLimit('apps.fork-starts-daily', gold, deps)).toBe(40);
    expect(
      await resolveUserAppLimit('apps.fork-starts-daily', 9, {
        ...deps,
        getSessionUser: async () => gold,
      })
    ).toBe(40);
    // A failed or anonymous read serves the lowest value any tier gets.
    expect(
      await resolveUserAppLimit('apps.fork-starts-daily', 9, {
        ...deps,
        getSessionUser: async () => {
          throw new Error('down');
        },
      })
    ).toBe(20);
    expect(await resolveUserAppLimit('apps.fork-starts-daily', null, deps)).toBe(20);
  });

  it('a failed config read serves the code default', async () => {
    expect(
      await resolveUserAppLimit('apps.goods-daily', 9, {
        getConfig: async () => {
          throw new Error('down');
        },
      })
    ).toBe(150_000);
  });
});
