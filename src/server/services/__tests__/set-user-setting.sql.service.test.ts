import { describe, it, expect, vi, beforeEach } from 'vitest';

// Correctness tests for the two SQL statements `setUserSetting` emits.
//
// 1. The merge statement built its jsonb payload by splicing `JSON.stringify(toSet)`
//    into a single-quoted SQL string literal. `JSON.stringify` escapes `"` and `\`
//    but NOT `'`, so any setting value holding an apostrophe closed the literal early
//    and the statement stopped meaning what it says. `preferredFiatCurrency`,
//    `tosAcceptedHash`, `tosGreenAcceptedHash`, `tosRedAcceptedHash` and every
//    `tourSettings` key are plain `z.string()` on `setUserSettingsInput`, so an
//    apostrophe reaches here unaltered.
//
// 2. The key-removal statement emitted a trailing `}` (`${toRemove.join(' - ')}}`),
//    which is not valid SQL — so that branch could never complete. It is reachable:
//    the tRPC transformer carries an explicit `undefined` property over the wire and
//    zod keeps the key, so `user.setSettings` can put a key on the removal list.
//
// Both statements are now parameterised tagged templates, so values are bound rather
// than pasted into the statement text. These tests assert exactly that: user data must
// appear in the bound values and never in the statement text.

const { statements, mockDb } = vi.hoisted(() => {
  const statements: { text: string; values: unknown[] }[] = [];
  return {
    statements,
    mockDb: {
      // Parameterised form. Two call shapes reach it: the tagged template
      // (`$executeRaw`…``) arrives as `(TemplateStringsArray, ...values)`, and a
      // pre-built `Prisma.sql` passed as an argument arrives as a `Prisma.Sql`
      // exposing `.sql` (text with $N placeholders) and `.values`. Reduce both to
      // the same {text, values} pair.
      $executeRaw: vi.fn(async (first: any, ...rest: unknown[]) => {
        if (Array.isArray(first) && Array.isArray(first.raw)) {
          const text = first.reduce(
            (acc: string, chunk: string, i: number) => acc + (i ? `$${i}` : '') + chunk,
            ''
          );
          statements.push({ text, values: rest });
        } else {
          statements.push({
            text: typeof first?.sql === 'string' ? first.sql : String(first),
            values: Array.isArray(first?.values) ? first.values : [],
          });
        }
        return 1;
      }),
      // Interpolating form: the whole statement arrives as one already-built string.
      $executeRawUnsafe: vi.fn(async (text: string, ...values: unknown[]) => {
        statements.push({ text: String(text), values });
        return 1;
      }),
      $queryRaw: vi.fn(async () => []),
    },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
// `setUserSetting` busts the user-settings cache after writing; keep Redis out of it.
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCachedObject: vi.fn(() => ({
    fetch: vi.fn(async () => ({})),
    bust: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  })),
}));
vi.mock('~/server/services/creator-membership.service', () => ({
  bustUserMetricPrivacyDefaultsCache: vi.fn(async () => undefined),
}));
// Stub the module surfaces user.service reaches at import time (mirrors the other
// user.service unit tests).
vi.mock('~/server/metrics', () => ({
  articleMetrics: { queueUpdate: vi.fn() },
  imageMetrics: { queueUpdate: vi.fn() },
  modelMetrics: { queueUpdate: vi.fn() },
  postMetrics: { queueUpdate: vi.fn() },
  userMetrics: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenModels: { refreshCache: vi.fn(async () => undefined) },
  HiddenModels3D: { refreshCache: vi.fn(async () => undefined) },
  HiddenUsers: { refreshCache: vi.fn(async () => undefined) },
  HiddenImages: { refreshCache: vi.fn(async () => undefined) },
  HiddenTags: { refreshCache: vi.fn(async () => undefined) },
  BlockedUsers: { refreshCache: vi.fn(async () => undefined), getCached: vi.fn(async () => []) },
  BlockedByUsers: { refreshCache: vi.fn(async () => undefined) },
  ImplicitHiddenImages: { refreshCache: vi.fn(async () => undefined) },
  toggleHidden: vi.fn(async () => ({ added: [], removed: [] })),
}));

import { setUserSetting } from '~/server/services/user.service';

const USER_ID = 4242;

beforeEach(() => {
  vi.clearAllMocks();
  statements.length = 0;
});

describe('setUserSetting — the merge statement', () => {
  it('preserves an apostrophe in a setting value', async () => {
    // A currency label a user can legitimately store via `user.setSettings`.
    const currency = "Côte d'Ivoire franc";

    await setUserSetting(USER_ID, { preferredFiatCurrency: currency });

    expect(statements).toHaveLength(1);
    const [merge] = statements;

    // The value must reach the database as a bound parameter, byte for byte.
    expect(merge.values).toContainEqual(JSON.stringify({ preferredFiatCurrency: currency }));
    // …and must not appear anywhere in the statement text, where an apostrophe
    // would close the surrounding string literal.
    expect(merge.text).not.toContain("d'Ivoire");
    expect(merge.text).not.toContain(currency);
  });

  it('binds a value holding a quote, a backslash and a brace without altering it', async () => {
    const hash = `a'b"c\\d}e`;

    await setUserSetting(USER_ID, { tosAcceptedHash: hash });

    const [merge] = statements;
    expect(merge.values).toContainEqual(JSON.stringify({ tosAcceptedHash: hash }));
    expect(merge.text).not.toContain(hash);
  });

  it('binds the user id rather than pasting it into the statement', async () => {
    await setUserSetting(USER_ID, { allowAds: true });

    const [merge] = statements;
    expect(merge.values).toContainEqual(USER_ID);
    expect(merge.text).not.toContain(String(USER_ID));
  });

  // The merge must stay a jsonb concatenation onto the existing column, so keys the
  // caller did not send are left alone rather than replaced wholesale.
  it('merges onto the existing settings column and sends only the given keys', async () => {
    await setUserSetting(USER_ID, { allowAds: true });

    const [merge] = statements;
    expect(merge.text).toContain('COALESCE(settings');
    expect(merge.text).toContain('||');
    expect(merge.values).toContainEqual(JSON.stringify({ allowAds: true }));
  });
});

describe('setUserSetting — the key-removal statement', () => {
  it('removes settings keys without error', async () => {
    await setUserSetting(USER_ID, {
      allowAds: true,
      // An explicit `undefined` marks a key for removal. This is what the tRPC
      // transformer delivers for `user.setSettings`.
      hideDonationGoals: undefined,
      swipeGalleryCards: undefined,
    });

    // One merge for `allowAds`, then one removal for the two undefined keys.
    expect(statements).toHaveLength(2);
    const removal = statements[1];

    // The stray brace made this statement unparseable; there must be no brace at all.
    expect(removal.text).not.toContain('}');
    // The key names are bound as one array, not pasted in and hand-quoted.
    expect(removal.values).toContainEqual(['hideDonationGoals', 'swipeGalleryCards']);
    expect(removal.text).not.toContain('hideDonationGoals');
  });

  it('binds a single removed key as an array too', async () => {
    await setUserSetting(USER_ID, { allowAds: true, hideDonationGoals: undefined });

    expect(statements).toHaveLength(2);
    const removal = statements[1];
    expect(removal.text).not.toContain('}');
    expect(removal.values).toContainEqual(['hideDonationGoals']);
  });

  it('emits no removal statement when nothing is marked for removal', async () => {
    await setUserSetting(USER_ID, { allowAds: true });

    expect(statements).toHaveLength(1);
  });
});
