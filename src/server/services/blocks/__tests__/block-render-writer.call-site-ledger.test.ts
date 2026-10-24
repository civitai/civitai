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
 *   3. who consults `isPrivateRunImpression` — the private-run gate (after setting aside
 *      the one ledgered caller that writes a different table).
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
 * exactly one file names `isPrivateRunImpression` in a comment without calling it. A
 * control below pins that population BY NAME, so the immunity is measured rather than
 * assumed and a deleted paragraph is a red test rather than a silently-inert control.
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
    // ⚠️ THE POPULATION IS EXACTLY ONE FILE — the client beacon emitter.
    // (`app-views.service.ts` names the module PATH, not the identifier; the two writers
    // name it in prose AND call it, so they are in CODE and correctly excluded.) With a
    // mere non-emptiness check the whole control would rest on ONE prose paragraph, and
    // this repo's comment policy actively encourages deleting paragraphs — so it is
    // pinned BY NAME. A deletion is then a red test with an obvious fix rather than a
    // control that silently stops controlling.
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

  // The custom-events ingest writes a different owner-visible table (`appBlockEvents`) and
  // applies the same gate. It is not a `blockRenders` writer, so it is ledgered apart.
  const OTHER_GATED_WRITERS = ['src/server/services/blocks/block-event-ingest.service.ts'];
  const GATE_CALLERS = [...WRITERS, ...OTHER_GATED_WRITERS].sort();

  it('🔴 EXACTLY these files consult the private-run gate', () => {
    expect(callersOf('isPrivateRunImpression')).toEqual(GATE_CALLERS);
  });

  it('EXACTLY the ledgered file inserts into the custom-events table', () => {
    // A second writer would have to consult the gate too. This sees one that names the table
    // through its exported constant and calls `.insert(`; a writer spelling the table as a
    // string literal is invisible here, as string literals are stripped from the scan.
    expect(
      FILES.filter((f) => {
        const code = CODE.get(f)!;
        return code.includes('APP_BLOCK_EVENTS_TABLE') && /\.insert\s*\(/.test(code);
      }).sort()
    ).toEqual(OTHER_GATED_WRITERS);
  });

  it('🔴 the three populations are THE SAME SET', () => {
    // Redundant while the three above are equalities; load-bearing the moment any is
    // relaxed to `toContain`.
    expect(callersOf('blockRenderTrackerPayload')).toEqual(trackerWriteSites());
    expect(
      callersOf('isPrivateRunImpression').filter((f) => !OTHER_GATED_WRITERS.includes(f))
    ).toEqual(trackerWriteSites());
  });

  /**
   * 🔴 THERE IS DELIBERATELY NO STRUCTURAL ASSERTION THAT A WRITER *ACTS* ON THE GATE'S
   * ANSWER. A text scan cannot see whether a value was used: in `track.router.ts` the
   * statement after the gate is the RECORDING path's own `return`, so any proximity
   * match is satisfied by `if (await isPrivateRunImpression({…}));` — compute, discard,
   * insert anyway. That is not a gap to patch; it is the boundary between this guard and
   * the behavioural one, which kills that mutant on the tRPC leg.
   */

  it("🔴 the gate is reached with the row's OWN app id, never a neighbouring field", () => {
    // The argument nobody pinned. `appBlockId: input.blockInstanceId` type-checks (both
    // are the same bounded string), reads plausibly (the instance id is literally
    // `page_<appBlockId>`), and changes NO outcome in any suite, because the leaf mocks
    // answer the same way for any id. In production it would gate on a non-existent app,
    // refuse `no-app`, and reopen the leak on that writer alone — the asymmetry this
    // ledger exists to prevent, on the one argument the viewer guard does not cover.
    //
    // The allowlisted spellings are exactly the fields each writer already uses to BUILD
    // the row, so the gate and the insert can never disagree about which app they mean.
    //
    // ⚠️ OBJECT SHORTHAND (`{ appBlockId, viewer }`) yields NO match and is caught only by
    // the `> 0` floor below — which holds because the gate call is currently the SOLE
    // `appBlockId:` site in each writer. Add a second one (a log field, a metric label)
    // and a shorthand gate call goes invisible. The sibling viewer guard has the same
    // property.
    const ALLOWED_APP_ID_SOURCES = [
      'appBlockId: result.data.appBlockId',
      'appBlockId: input.appBlockId',
    ];
    for (const f of WRITERS) {
      const used = CODE.get(f)!.match(/appBlockId\s*:\s*[^,}\n]+/g) ?? [];
      expect(used.length, `${f} must thread an app id into the gate`).toBeGreaterThan(0);
      for (const match of used) {
        const spelling = match.replace(/\s+/g, ' ').trim();
        expect(
          ALLOWED_APP_ID_SOURCES,
          `${f} threads \`${spelling}\` — the gate must see the row's own app id`
        ).toContain(spelling);
      }
    }
  });

  it('the gate is reached with a SERVER-RESOLVED viewer, never a parsed body field', () => {
    // 🔴 ENUMERATE, DO NOT SAMPLE AN ALLOWLIST — the difference between "a good spelling
    // exists" and "no bad one exists", and only the second is the claim. Whitespace is
    // normalised rather than trimmed so a prettier reflow (`viewer:\n  ctx.user`) is not
    // a false red, and `viewer\s*:` so an extra space is not a hole.
    //
    // Sibling home: `src/test-utils/routerSourceRegions.ts` owns the repo's other
    // private-run spelling sets and their pairwise-disjointness test. This pair is NOT
    // moved there on purpose — that module's sets are all about the `privateRun:` TOKEN
    // CLAIM rail, and a `viewer:` SESSION-rail constant filed alongside them invites
    // exactly the wrong coupling. Keep them separate; look there before editing either.
    const ALLOWED_VIEWER_SOURCES = ['viewer: session?.user', 'viewer: ctx.user'];
    for (const f of WRITERS) {
      const used = CODE.get(f)!.match(/viewer\s*:\s*[^,}\n]+/g) ?? [];
      expect(used.length, `${f} must thread a viewer into the gate`).toBeGreaterThan(0);
      for (const match of used) {
        const spelling = match.replace(/\s+/g, ' ').trim();
        expect(
          ALLOWED_VIEWER_SOURCES,
          `${f} threads \`${spelling}\` — only a SERVER-RESOLVED session may reach the gate`
        ).toContain(spelling);
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

  it('🔴 the gate DEFERS the flag and the predicate — static imports would sink the beacon', () => {
    // The one property the gate's docblock calls load-bearing that nothing else observes.
    // Converting either `await import(...)` to a top-level import type-checks, keeps every
    // suite green, and silently drags Flipt, Prisma and the app-blocks service graph into
    // the eager import path of a route whose entire reason for existing is to avoid that.
    // Same technique as the `tracker.ts` control below, pointed at the gate's own imports.
    const gate = CODE.get('src/server/services/blocks/private-run-impression.service.ts')!;
    for (const deferred of [
      '~/server/services/app-blocks-flag',
      '~/server/services/blocks/private-run-access.service',
    ]) {
      // `CODE` has string literals stripped, so the specifier is matched against RAW text;
      // the `import(` shape is matched against CODE so prose cannot satisfy it.
      expect(
        raw('src/server/services/blocks/private-run-impression.service.ts'),
        `${deferred} must still be referenced`
      ).toContain(deferred);
    }
    // Two dynamic imports, and no static `import … from` beyond the two cheap ones the
    // beacon route already pulls in.
    expect(
      (gate.match(/await import\(/g) ?? []).length,
      'the flag and the predicate must BOTH stay behind `await import`'
    ).toBe(2);

    // 🔴 ENUMERATED EQUALITY, NOT TWO SAMPLES. Asserting that the two cheap specifiers are
    // PRESENT says nothing about a third being ADDED — `import { dbRead } from
    // '~/server/db/client'` would have left the earlier form of this test green, which is
    // precisely the eager-Prisma edge it exists to prevent. Enumerating also subsumes the
    // namespace and default import forms, which a named-import regex cannot see.
    //
    // Specifiers live in string literals, which `CODE` strips — so this reads RAW, and
    // `^import` anchored per line skips block-comment continuations (` *`) and `// import`.
    // It is a claim about THIS FILE's static imports, not about the graph below them: a
    // barrel re-export through an already-listed specifier is invisible to any text scan.
    const gateRaw = raw('src/server/services/blocks/private-run-impression.service.ts');
    const staticSpecifiers = [...gateRaw.matchAll(/^import\s[\s\S]*?from\s+'([^']+)'/gm)]
      .map((m) => m[1])
      .sort();
    expect(
      staticSpecifiers,
      "a new static import here lands Flipt or Prisma in the beacon route's EAGER graph"
    ).toEqual([
      '~/server/logging/client',
      '~/server/services/blocks/known-app-blocks.service',
      '~/types/session',
    ]);
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
