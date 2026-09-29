import { describe, expect, it } from 'vitest';
import { scanSource } from '../../../../../test/source-scan';

/**
 * THE `blockRenders` WRITER SET, LEDGERED — and the ledger pins a RELATIONSHIP, not a
 * population.
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────────
 * 🔴 TWO WRITERS INSERT INTO `blockRenders`: the `/api/track/block-render` beacon (what
 * the browser hosts use) and the `track.blockRender` tRPC procedure (kept for
 * bearer/API-key callers). Every rule that table needs therefore has to be applied
 * TWICE, and the repo already carries two mechanisms built for exactly that:
 * `blockRenderTrackerPayload` is a shared allowlist so an observability field cannot be
 * stripped on one side and forwarded on the other, and `secondary` suppresses the insert
 * symmetrically in both. The private-run exclusion is the third such rule, and a
 * one-sided version of it would let a bearer caller reintroduce the leak on the path
 * nobody watches.
 *
 * So this file asserts the three populations are THE SAME SET, and that the set is
 * exactly the two ledgered files:
 *
 *   1. who calls `.blockRender(` on a tracker — i.e. who writes the table at all;
 *   2. who builds the row through `blockRenderTrackerPayload` — the payload allowlist;
 *   3. who consults `isPrivateRunImpression` — the private-run gate.
 *
 * Equality in all three directions is what makes a NEW writer fail here: adding one
 * lands it in (1) and, unless it also does (2) and (3), the sets diverge. Deleting a
 * writer fails too — which matters because an exclusion that covers "both writers" stops
 * being a claim about anything the moment the writer set changes under it.
 *
 * ── WHY IT IS A SOURCE-TEXT GUARD, AND WHY THAT IS NOT ENOUGH ALONE ─────────────
 * A STRUCTURAL check TYPE-CHECKS PAST A WRONG ARGUMENT: it cannot see a writer that
 * calls the gate with the wrong app id, with a body-derived viewer, or that ignores the
 * answer. That is the behavioural half's job — `src/tests/api/track/block-render.private-run.test.ts`
 * drives ONE fixture through both real writers and asserts they agree. Neither half is
 * sufficient: this one cannot see a wrong value, that one cannot see a third writer.
 *
 * ⚠️ `stripCommentsAndStrings` removes STRING LITERALS as well as comments, which is what
 * makes the scan immune to a name written in prose — and there IS prose to be immune to:
 * three files name `isPrivateRunImpression` in comments without calling it. A control
 * below requires that population to be non-empty, so the immunity is measured rather
 * than assumed.
 */

const ROOT = process.cwd();

/**
 * Where each scanned symbol is DEFINED, excluded from its own call-site set.
 *
 * A hand-written map rather than a regex, for the reason the sibling private-run ledger
 * records: `/function <name>/` cannot see a class method, and `blockRender` is exactly
 * that — a method on `Tracker`. Inferring "where is this defined" with a pattern that can
 * be wrong is how a defining file gets counted as a caller.
 */
const DEFINED_IN: Record<string, string> = {
  blockRenderTrackerPayload: 'src/server/schema/track.schema.ts',
  isPrivateRunImpression: 'src/server/services/blocks/private-run-impression.service.ts',
};

// The walk, the comment/string strip and the caller scan are SHARED — see
// `test/source-scan.ts` for why the population filter in particular must not be copied.
const { files: FILES, code: CODE, raw, callersOf } = scanSource(ROOT, DEFINED_IN);

/**
 * Files that call `.blockRender(` ON SOMETHING — a tracker instance or `ctx.track`.
 *
 * 🔴 THE LEADING DOT IS LOAD-BEARING. Without it the pattern also matches the METHOD
 * DECLARATION inside `Tracker` (`public blockRender(values: {…})`), so `tracker.ts` would
 * be counted as a writer of the table it merely implements — and the ledger would then
 * demand a private-run gate inside the generic ClickHouse client, which is the one place
 * it must not live (it would drag Prisma, Flipt and the app-blocks service graph into a
 * module every route imports).
 */
function trackerWriteSites(): string[] {
  return FILES.filter((f) => /\.blockRender\s*\(/.test(CODE.get(f)!)).sort();
}

describe('the blockRenders writer set — instrument validation', () => {
  it('POSITIVE CONTROL: the scan enumerates a real population and can match', () => {
    // A broken walk, or a regex that matches nothing, would make every assertion below
    // vacuously true. Prove the instrument works before reading its verdict.
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain('src/pages/api/track/block-render.ts');
    expect(FILES).toContain('src/server/routers/track.router.ts');
    expect(FILES).toContain('src/server/clickhouse/tracker.ts');
    expect(callersOf('blockRenderTrackerPayload').length).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: a definitely-absent symbol matches nothing', () => {
    expect(callersOf('isPrivateRunImpressionNoSuchFunction')).toEqual([]);
  });

  it('🔴 CONTROL: the scan reads CODE, so a mention in a COMMENT is not a call site', () => {
    // The failure this prevents has bitten a sibling ledger: a regex over RAW source turns
    // green the moment somebody writes the gate's name in a doc comment, with the file
    // calling nothing.
    //
    // ⚠️ THE POPULATION IS EXACTLY ONE FILE, AND THIS USED TO SAY "several" — measured, it
    // is the client beacon emitter alone. (`app-views.service.ts` names the module PATH,
    // not the identifier; the two writers name it in prose AND call it, so they are in
    // CODE and correctly excluded.) That matters: with `toBeGreaterThan(0)` the whole
    // control rests on ONE prose paragraph, and this repo's comment policy actively
    // encourages deleting paragraphs — so it is pinned BY NAME, and a deletion is then a
    // red test with an obvious fix rather than a control that silently stops controlling.
    const mentionsInProse = FILES.filter((f) => {
      const text = raw(f);
      return (
        text.includes('isPrivateRunImpression') && !CODE.get(f)!.includes('isPrivateRunImpression')
      );
    });
    expect(mentionsInProse).toEqual(['src/components/AppBlocks/sendBlockRender.ts']);
    for (const f of mentionsInProse) {
      expect(callersOf('isPrivateRunImpression')).not.toContain(f);
    }
  });

  it('🔴 CONTROL: the tracker METHOD DECLARATION is not counted as a write site', () => {
    // The dot in the pattern, asserted. If this ever fails, `trackerWriteSites()` has
    // started including the generic ClickHouse client and every equality below is now
    // demanding app-blocks logic inside it.
    expect(raw('src/server/clickhouse/tracker.ts')).toContain('public blockRender(');
    expect(trackerWriteSites()).not.toContain('src/server/clickhouse/tracker.ts');
  });
});

describe('the blockRenders writer set — the ledger [INV]', () => {
  /**
   * 🔴 ENUMERATED EQUALITY, NEVER CONTAINMENT. A third writer fails here, and so does
   * deleting one. If you are here because a name is missing or extra, the fix is to decide
   * whether the new surface must carry BOTH table-wide rules — the payload allowlist and
   * the private-run gate — not to bump the list.
   */
  const WRITERS = [
    // The REST beacon. What every browser host uses, at BLOCK_READY, once per host mount.
    'src/pages/api/track/block-render.ts',
    // The legacy tRPC procedure. No prom counter, no histogram — a ClickHouse writer only,
    // reachable by a bearer/API-key caller who never runs the browser beacon.
    'src/server/routers/track.router.ts',
  ].sort();

  it('EXACTLY these files write the table', () => {
    expect(trackerWriteSites()).toEqual(WRITERS);
  });

  it('EXACTLY these files build the row through the payload allowlist', () => {
    // Same set, different mechanism: a writer that assembles its own payload would appear
    // in the set above and be missing here, which is the drift `blockRenderTrackerPayload`
    // exists to prevent.
    expect(callersOf('blockRenderTrackerPayload')).toEqual(WRITERS);
  });

  it('🔴 EXACTLY these files consult the private-run gate', () => {
    expect(callersOf('isPrivateRunImpression')).toEqual(WRITERS);
  });

  it('🔴 the three populations are THE SAME SET', () => {
    // The relationship, stated directly rather than inferred from three separate equalities
    // against a constant: whoever writes the table must also strip through the allowlist
    // AND consult the gate. Stated this way the assertion survives a future edit to
    // `WRITERS` — the sets must agree with each other even if the ledger is wrong.
    expect(callersOf('blockRenderTrackerPayload')).toEqual(trackerWriteSites());
    expect(callersOf('isPrivateRunImpression')).toEqual(trackerWriteSites());
  });

  /**
   * 🔴 DELETED, NOT TIGHTENED: an assertion that each writer "SUPPRESSES on the gate
   * rather than merely calling it", matched as
   * `if\s*\(await isPrivateRunImpression\(\{…\}\)\)[\s\S]{0,80}?return`.
   *
   * It was a guard on a SPELLING, and review demonstrated the walk rather than arguing
   * it. In `track.router.ts` the statement AFTER the gate is `return ctx.track.blockRender
   * (…)` — the RECORDING path's own `return`. So the mutant
   * `if (await isPrivateRunImpression({…}));` — compute the answer, discard it, insert
   * anyway — matched and went GREEN: the guard's evidence came from the code path it
   * existed to exclude. It was also pinned to a source line sitting exactly at prettier's
   * `printWidth: 100`, so a one-character rename anywhere on that line reformats the `if`
   * across lines and fires a guard whose message names a deleted gate.
   *
   * Tightening the regex was the obvious fix and is how the first weakness got there.
   * The property is already carried, behaviourally and per writer, by
   * `src/tests/api/track/block-render.private-run.test.ts` — which kills that exact
   * mutant on the tRPC leg (1 row where 0 is expected). A structural scan cannot see
   * whether an answer was USED; that is not a gap to patch, it is the boundary between
   * the two halves of this guard.
   */

  it('the gate is reached with a SERVER-RESOLVED viewer, never a parsed body field', () => {
    // 🔴 ENUMERATE, DO NOT SAMPLE AN ALLOWLIST. This used to be
    // `ALLOWED.filter(s => code.includes(s))` → `toHaveLength(1)`, which asserts that one
    // of two permitted spellings is PRESENT and says nothing about any other. Review ran
    // the mutant: a SECOND gate call with `viewer: input.viewer` alongside the correct one
    // left the count at 1 and passed. Matching every `viewer:` in the file and requiring
    // each to be allowlisted is the difference between "a good one exists" and "no bad one
    // exists", and only the second is the claim.
    const ALLOWED_VIEWER_SOURCES = ['viewer: session?.user', 'viewer: ctx.user'];
    for (const f of WRITERS) {
      const used = CODE.get(f)!.match(/viewer:\s*[^,}\n]+/g) ?? [];
      expect(used.length, `${f} must thread a viewer into the gate`).toBeGreaterThan(0);
      for (const spelling of used) {
        expect(
          ALLOWED_VIEWER_SOURCES,
          `${f} threads \`${spelling.trim()}\` — only a SERVER-RESOLVED session may reach the gate`
        ).toContain(spelling.trim());
      }
    }
  });

  it('the beacon route still derives isAnon server-side, unchanged', () => {
    // A control on the neighbouring rule: if this stopped being true, the writer would be
    // taking viewer identity from the client and the gate's derivation argument would be
    // resting on something that no longer holds.
    expect(CODE.get('src/pages/api/track/block-render.ts')!).toContain('isAnon: !session?.user');
    expect(CODE.get('src/server/routers/track.router.ts')!).toContain('isAnon: !ctx.user');
  });

  it('🔴 the private-run gate is NOT reachable from the generic ClickHouse client', () => {
    // The mirror of the tracker control above, as a non-goal: the gate must stay out of a
    // module every route imports. Putting it there would look like better symmetry and
    // would drag Prisma, Flipt and the app-blocks service graph into the lightweight
    // beacon's import path — the one cost that route exists to avoid.
    //
    // 🔴 THE PAIRED POSITIVE CONTROL IS NOT OPTIONAL. `stripCommentsAndStrings` is
    // documented as biased toward over-stripping, so a `not.toContain` against a CODE
    // entry that had been stripped to whitespace would pass having measured nothing —
    // a reassuring zero. This line proves the same CODE entry can still match.
    expect(CODE.get('src/server/clickhouse/tracker.ts')!).toContain('blockRender');
    expect(CODE.get('src/server/clickhouse/tracker.ts')!).not.toContain('isPrivateRunImpression');
  });
});
