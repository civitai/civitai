import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

import { appListingNotifications } from '~/server/notifications/app-listing.notifications';

/**
 * 🔴 THE SEAM: `AppListingOwnerNotificationType` (what the services are ALLOWED to emit) and
 * the key set of `appListingNotifications` (what can be RENDERED) are related by nothing but
 * hand-editing.
 *
 * `notifyAppListingOwner` types its `type` against that union, but `createNotification` takes a
 * free-form string — so a member added to the union with no processor entry compiles,
 * typechecks, and emits a notification with no `prepareMessage`. Both halves also live in
 * different files, so no single review diff necessarily shows both.
 *
 * This is a RELATIONSHIP guard, and it fails in BOTH directions on purpose: a union member with
 * no processor (emit something unrenderable) and a processor key outside the union (dead entry,
 * or a rename that silently orphaned its emitter). A one-directional check would pass while
 * half the drift it exists to catch sat in the tree.
 *
 * Written when `app-listing-purged` took the set from four to five by hand and got it right —
 * i.e. before it cost anything, not after.
 */

const NOTIFY_SRC = path.resolve(__dirname, '../../services/blocks/app-listing-notify.ts');

/**
 * The union is a TYPE, so it is erased at runtime and cannot be read by import. Parse it out of
 * the source instead.
 *
 * 🔴 The parse is itself asserted below rather than trusted: a regex that silently matched
 * nothing would yield an empty union, every `⊆` check would pass vacuously, and the guard would
 * report success while comparing nothing. That is the failure mode this whole file exists to
 * prevent, so it must not be the failure mode of the file.
 *
 * 🔴 COMMENTS ARE STRIPPED BEFORE THE MATCH, AND THAT IS NOT TIDINESS. The first version
 * terminated on the first `;`, which a `//` comment inside the union can contain — the union
 * already carries multi-line commentary between members, so a semicolon there is an ordinary
 * authoring act. Measured: a `;` in a trailing comment immediately before a newly appended,
 * processor-less member truncated the parse to drop exactly that member, and ALL FOUR tests
 * passed — including the positive control, which only checks the union is non-empty and
 * contains a long-standing member. The guard read as coverage for the case most likely to
 * arise (a member appended at the end) while providing none.
 *
 * ⚠ NOTHING DOWNSTREAM CAN CATCH THAT — a claim an earlier revision of this comment got wrong
 * in the same way. A truncated parse is a SUBSET of the processor set, so both `⊆` tests pass;
 * set equality being forced, the size comparison passes too. Measured green against exactly
 * that scenario. **The stripping IS the guard**, so it is pinned directly by
 * `parseUnionFrom`'s own tests at the bottom of this file, against synthetic sources whose
 * answer is known without reading the file under audit.
 */
export function parseUnionFrom(source: string): string[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const decl = /export type AppListingOwnerNotificationType\s*=([\s\S]*?);/.exec(src);
  if (!decl) throw new Error('could not locate the union declaration');
  return [...decl[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
}

function parseEmitUnion(): string[] {
  return parseUnionFrom(readFileSync(NOTIFY_SRC, 'utf8'));
}

describe('app-listing owner notifications — the emit union and the processor keys agree', () => {
  it('POSITIVE CONTROL: the union actually parsed, and the processor set is non-empty', () => {
    // Without this, both set comparisons below are claims about empty sets.
    const union = parseEmitUnion();
    expect(union.length).toBeGreaterThanOrEqual(4);
    expect(union).toContain('app-listing-approved');
    expect(Object.keys(appListingNotifications).length).toBeGreaterThanOrEqual(4);
  });

  it('every EMITTABLE type has a processor entry (else it emits unrenderable)', () => {
    const processors = new Set(Object.keys(appListingNotifications));
    const missing = parseEmitUnion().filter((t) => !processors.has(t));
    expect(missing, 'union members with no notification processor').toEqual([]);
  });

  it('every PROCESSOR key is emittable (else it is dead, or its emitter was renamed)', () => {
    const union = new Set(parseEmitUnion());
    // 🔴 NO EXCLUSION LIST. An earlier revision carved out `new-app-listing-comment` on the
    // belief that it lived in this processor set; it does not — it is registered in
    // `comment.notifications.ts` — so the carve-out was DEAD, and a dead exclusion is a
    // permanent hole for whichever key it names.
    const orphaned = Object.keys(appListingNotifications).filter((k) => !union.has(k));
    expect(orphaned, 'processor entries nothing is allowed to emit').toEqual([]);
  });

  /**
   * ⚠ THIS CATCHES DUPLICATES, NOT TRUNCATION — and the name says so because an earlier
   * revision claimed the opposite and was wrong.
   *
   * The two `⊆` tests above already force `set(parsed) === set(processors)`. Given that,
   * comparing sizes can only fail when `parsed` holds a DUPLICATE — a truncation removes
   * members and never creates one, so this assertion is structurally incapable of seeing it.
   * The comment that used to sit here said it was "the second half of the fix" for truncation;
   * it was measured as green against exactly that scenario. Truncation is caught by the
   * comment-stripping in the parser, which is why the parser now has its own tests below
   * instead of being trusted through this one.
   */
  it('no DUPLICATE union member (this does NOT catch a truncated parse — see below)', () => {
    const union = parseEmitUnion();
    expect(new Set(union).size).toBe(union.length);
  });

  it('every processor renders a non-empty message and a url for a minimal payload', () => {
    // A `details` with only the required `slug` — the terse shape `appLabel` falls back on.
    for (const [type, processor] of Object.entries(appListingNotifications)) {
      const prepared = processor.prepareMessage?.({
        details: { slug: 'some-app' },
      } as never);
      expect(prepared, `${type} produced no message`).toBeTruthy();
      expect(prepared?.message?.length, `${type} rendered an empty message`).toBeGreaterThan(0);
      expect(prepared?.url, `${type} rendered no url`).toBeTruthy();
    }
  });
});

/**
 * 🔴 THE PARSER GETS ITS OWN TESTS, because every assertion above is downstream of it and
 * therefore cannot see it fail in the direction that matters.
 *
 * A parse that silently DROPS a member produces a union that is a subset of the processor set —
 * so both `⊆` checks pass, and (set equality being forced) so does the size comparison. Measured:
 * with the comment-stripping reverted, round 3's exact scenario left all five tests above green.
 * The only thing standing between that and a shipped, unrenderable notification type is the
 * stripping, so the stripping is what has to be pinned — directly, against synthetic sources,
 * where the expected answer is known independently of the file under audit.
 */
describe('parseUnionFrom — the parse itself, against sources with known answers', () => {
  const union = (members: string, extra = '') =>
    `export type AppListingOwnerNotificationType =\n${extra}${members};\n`;

  it('POSITIVE CONTROL: reads a plain union', () => {
    expect(parseUnionFrom(union(`  | 'a-one'\n  | 'a-two'`))).toEqual(['a-one', 'a-two']);
  });

  it('🔴 a semicolon inside a // comment does NOT truncate the union', () => {
    const src = union(`  | 'a-one'\n  // NOTE: emitted by the new sweep; see #1234.\n  | 'a-two'`);
    // Pre-fix this returned ['a-one'] — dropping exactly the appended member, which is the
    // member most likely to be the new, processor-less one.
    expect(parseUnionFrom(src)).toEqual(['a-one', 'a-two']);
  });

  it('🔴 a semicolon inside a block comment does NOT truncate it either', () => {
    const src = union(`  | 'a-one'\n  /* first; second */\n  | 'a-two'`);
    expect(parseUnionFrom(src)).toEqual(['a-one', 'a-two']);
  });

  it('a // inside a string elsewhere in the file does not corrupt the parse', () => {
    const src = `const DOCS = 'https://civitai.com/docs';\n` + union(`  | 'a-one'\n  | 'a-two'`);
    expect(parseUnionFrom(src)).toEqual(['a-one', 'a-two']);
  });

  it('throws loudly when the declaration is absent, rather than returning []', () => {
    // An empty return would make every ⊆ check above vacuously true.
    expect(() => parseUnionFrom('export type Something = string;')).toThrow(/union declaration/);
  });
});
