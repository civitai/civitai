import { describe, it, expect, vi, beforeEach } from 'vitest';

// Statement-shape tests for the ONE place `User.settings` is written.
//
// History this file exists to hold shut:
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
// 3. Set and remove were TWO separate statements, and the merge was written from a
//    JS-side snapshot of the blob. Both are now one statement over the stored column,
//    which is what makes a settings write survive a concurrent one. The behavioural
//    proof of that is user-settings-race.behavior.test.ts, which runs these statements
//    against a real Postgres and interleaves two requests; this file pins the emitted
//    SHAPE, which a behavioural test on one engine cannot.
//
// Where a value lives is only half of it: a statement can bind every value correctly
// and still be rejected by Postgres if the operator, the cast, or the placeholder's
// position is wrong — and an assertion that only reads `values`, or only asserts a
// negative on the text, cannot see that. So each statement pins its shape too.

const { statements, mockDb } = vi.hoisted(() => {
  const statements: { text: string; values: unknown[] }[] = [];

  // Three call shapes reach the capture. The tagged template (`$executeRaw`…``) arrives
  // as `(TemplateStringsArray, ...values)`; a pre-built `Prisma.sql` arrives as an object
  // exposing `.sql`/`.values`; the interpolating `$queryRawUnsafe` / `$executeRawUnsafe`
  // arrive as one finished string plus values. All reduce to the same {text, values}
  // pair, so a statement can never go unrecorded and read as a pass.
  const record = (first: unknown, rest: unknown[]) => {
    if (Array.isArray(first) && Array.isArray((first as unknown as TemplateStringsArray).raw)) {
      const text = (first as string[]).reduce(
        (acc: string, chunk: string, i: number) => acc + (i ? `$${i}` : '') + chunk,
        ''
      );
      statements.push({ text, values: rest });
    } else if (
      first &&
      typeof first === 'object' &&
      typeof (first as { sql?: unknown }).sql === 'string'
    ) {
      const frag = first as { sql: string; values?: unknown[] };
      statements.push({ text: frag.sql, values: Array.isArray(frag.values) ? frag.values : [] });
    } else {
      statements.push({ text: String(first), values: rest });
    }
  };

  return {
    statements,
    mockDb: {
      $executeRaw: vi.fn(async (first: unknown, ...rest: unknown[]) => {
        record(first, rest);
        return 1;
      }),
      $executeRawUnsafe: vi.fn(async (first: unknown, ...rest: unknown[]) => {
        record(first, rest);
        return 1;
      }),
      $queryRawUnsafe: vi.fn(async (first: unknown, ...rest: unknown[]) => {
        record(first, rest);
        return [{ settings: {} }];
      }),
      $queryRaw: vi.fn(async () => []),
    },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
// The settings writers bust the user-settings cache after writing; keep Redis out of it.
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

import {
  patchUserSettings,
  setAlertDismissed,
  setUserSetting,
} from '~/server/services/user.service';

const USER_ID = 4242;

// The original removal statement ended in a stray `}` that made it unparseable. The
// combined statement legitimately contains the empty-object literal `'{}'`, so drop
// those before looking for a loose brace — assert the DEFECT, not the character.
const withoutEmptyObjectLiterals = (text: string) => text.replace(/'\{\}'/g, '');

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

  // The payload has to sit next to the cast as a bare `$N`. Re-wrapping it in quotes
  // (`'$N'::jsonb`) still binds the value, so every values-based assertion above stays
  // green — but Postgres then casts the literal two-character text `$N` and rejects it.
  // That is the original defect in a new costume, so pin the emitted shape too.
  // Every other case here writes `true`. Turning a toggle OFF sends `false`, which must be
  // STORED as false, not treated as empty: `removeEmpty` dropping falsy would take the key out of
  // the set half without putting it in the remove half, `patchUserSettings` would take its
  // empty-patch early return, and the write would silently become a read — green mutation,
  // optimistic UI showing the switch flipping, and the setting un-turn-off-able after a refresh.
  it('stores an off toggle as false rather than treating it as empty', async () => {
    await setUserSetting(USER_ID, { hideBlueBuzzInHeader: false });

    expect(statements).toHaveLength(1);
    const [merge] = statements;
    expect(merge.values).toContainEqual(JSON.stringify({ hideBlueBuzzInHeader: false }));
    // False means store false. Removal is the `undefined` branch, covered below.
    expect(merge.text).not.toContain('::text[]');
  });

  it('places the payload beside the jsonb cast as a bare placeholder', async () => {
    await setUserSetting(USER_ID, { allowAds: true });

    const [merge] = statements;
    expect(merge.text).toMatch(/\|\|\s*\$\d+::jsonb/);
    expect(merge.text).not.toMatch(/'\$\d+'/);
  });
});

describe('setUserSetting — key removal', () => {
  it('removes settings keys without error', async () => {
    await setUserSetting(USER_ID, {
      allowAds: true,
      // An explicit `undefined` marks a key for removal. This is what the tRPC
      // transformer delivers for `user.setSettings`.
      hideDonationGoals: undefined,
      swipeGalleryCards: undefined,
    });

    const [write] = statements;
    expect(withoutEmptyObjectLiterals(write.text)).not.toContain('}');
    // The key names are bound as one array, not pasted in and hand-quoted.
    expect(write.values).toContainEqual(['hideDonationGoals', 'swipeGalleryCards']);
    expect(write.text).not.toContain('hideDonationGoals');
  });

  it('binds a single removed key as an array too', async () => {
    await setUserSetting(USER_ID, { allowAds: true, hideDonationGoals: undefined });

    const [write] = statements;
    expect(withoutEmptyObjectLiterals(write.text)).not.toContain('}');
    expect(write.values).toContainEqual(['hideDonationGoals']);
  });

  it('emits no subtraction when nothing is marked for removal', async () => {
    await setUserSetting(USER_ID, { allowAds: true });

    expect(statements).toHaveLength(1);
    expect(statements[0].text).not.toContain('::text[]');
  });

  // `jsonb - text[]` is the only form that accepts a bound array of key names; any other
  // cast on that operand is rejected outright. The assertions above read `values` or
  // assert a negative on the text, so a wrong cast would leave all of them green.
  it('casts the bound key array to text[]', async () => {
    await setUserSetting(USER_ID, { allowAds: true, hideDonationGoals: undefined });

    const [write] = statements;
    expect(write.text).toContain('::text[]');
    expect(write.text).toMatch(/\$\d+::text\[\]/);
  });

  // Delete, not merge. Swapping `-` for `||` is both an operator Postgres has no
  // definition for at these operand types and the opposite meaning from the one this
  // branch exists to express — and nothing above would notice the swap.
  it('subtracts the key array rather than concatenating it', async () => {
    await setUserSetting(USER_ID, { allowAds: true, hideDonationGoals: undefined });

    const [write] = statements;
    expect(write.text).toMatch(/-\s*\$\d+::text\[\]/);
  });

  // The set and the removal used to be two statements with no transaction around them,
  // so a reader could observe the blob with the new keys written and the dead keys still
  // present. One statement removes that window by construction.
  it('sets and removes in a SINGLE statement', async () => {
    await setUserSetting(USER_ID, { allowAds: true, hideDonationGoals: undefined });

    expect(statements).toHaveLength(1);
    expect(statements[0].text).toContain('||');
    expect(statements[0].text).toContain('::text[]');
  });

  it('still writes the removal when every supplied key is a removal', async () => {
    // `removeEmpty` strips the undefined values, so the payload half is empty. The old
    // code returned early on that and the removal never ran.
    await setUserSetting(USER_ID, { hideDonationGoals: undefined });

    expect(statements).toHaveLength(1);
    expect(statements[0].values).toContainEqual(['hideDonationGoals']);
  });
});

describe('patchUserSettings — the nested merge', () => {
  it('merges INTO the named key rather than replacing it', async () => {
    await patchUserSettings(USER_ID, { mergeInto: { features: { someFlag: true } } });

    expect(statements).toHaveLength(1);
    const [write] = statements;
    // The sub-object is read from the column inside the same statement — that is what
    // keeps a sibling sub-key another writer just added.
    //
    // The read is wrapped in a `jsonb_typeof` object test rather than the `COALESCE`
    // this used to pin. `COALESCE` only replaces SQL NULL (an ABSENT key); a key that
    // is PRESENT holding a non-object — JSON `null` most likely — passes straight
    // through it, and `jsonb || jsonb` CONCATENATES rather than raising, turning the
    // key into an array that grows on every subsequent write. Behaviour is covered in
    // `user-settings-mergeinto-malformed.behavior.test.ts` against a real engine; this
    // assertion pins the STATEMENT SHAPE, so both halves are named here: the read of
    // the live column (atomicity) and the guard around it (shape).
    expect(write.text).toMatch(
      /CASE WHEN jsonb_typeof\(settings->\$\d+::text\) = *'object' *THEN *settings->\$\d+::text *ELSE *'\{\}'::jsonb *END *\|\| *\$\d+::jsonb/
    );
    expect(write.values).toContainEqual('features');
    expect(write.values).toContainEqual(JSON.stringify({ someFlag: true }));
    // The key name binds; it is never pasted into the text (a settings key is fixed
    // vocabulary today, but the statement must not depend on that).
    expect(write.text).not.toContain('features');
  });

  it('returns the stored blob rather than a JS-side reconstruction', async () => {
    await patchUserSettings(USER_ID, { set: { allowAds: true } });

    expect(statements[0].text).toContain('RETURNING settings');
  });

  it('writes nothing when there is nothing to change', async () => {
    await patchUserSettings(USER_ID, { set: {}, mergeInto: {}, remove: [] });

    expect(statements.filter((s) => s.text.includes('UPDATE'))).toHaveLength(0);
  });
});

describe('setAlertDismissed — the set operation', () => {
  it('appends to the STORED array, guarded against a duplicate', async () => {
    await setAlertDismissed(USER_ID, 'notice-a', true);

    expect(statements).toHaveLength(1);
    const [write] = statements;
    // Read and write in one statement: the array is never carried through JS, which is
    // what lets two dismissals of different notices overlap.
    expect(write.text).toContain(`settings->'dismissedAlerts'`);
    expect(write.text).toContain('jsonb_build_array($1::text)');
    // Idempotence is a containment check on the stored array, not a JS `Set`.
    expect(write.text).toContain('@> to_jsonb($1::text)');
    expect(write.values).toEqual(['notice-a', USER_ID]);
    // The alert id must never reach the statement text.
    expect(write.text).not.toContain('notice-a');
  });

  it('filters the STORED array on removal, and never yields SQL NULL', async () => {
    await setAlertDismissed(USER_ID, 'notice-a', false);

    const [write] = statements;
    expect(write.text).toContain('jsonb_array_elements');
    expect(write.text).toMatch(/WHERE e <> to_jsonb\(\$1::text\)/);
    // `jsonb_agg` over an empty set returns NULL; without this the last removal would
    // write a NULL into the key instead of an empty array.
    expect(write.text).toMatch(/COALESCE\(\(\s*SELECT jsonb_agg/);
    expect(write.text).toContain(`'[]'::jsonb`);
    expect(write.values).toEqual(['notice-a', USER_ID]);
  });

  it('writes through jsonb_set on the dismissedAlerts path only', async () => {
    await setAlertDismissed(USER_ID, 'notice-a', true);

    const [write] = statements;
    expect(write.text).toMatch(
      /jsonb_set\(COALESCE\(settings, '\{\}'::jsonb\), '\{dismissedAlerts\}'/
    );
  });
});
