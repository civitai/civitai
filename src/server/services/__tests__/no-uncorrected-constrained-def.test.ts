import { globSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every generation field whose OUTPUT is constrained must carry a `correct` or a `coerce`,
 * and a call site that overrides `correct` must fall through to the def's.
 *
 * `store.set()` writes TRUSTED intent and skips `input` entirely, so ingestion — remix,
 * replay, append, preset apply — lands another family's value verbatim and `validate()`
 * refuses it, and the submit is blocked. The footer DOES report this — it shows "Check your
 * settings" naming the field (`getMissingFieldMessage`, added 2026-09-25) — so the failure is
 * not silent. What makes it unactionable is that only 15 inputs render `error={error?.message}`
 * at the control itself (prompt, images, controlNets, styleReferences, controlVideo, lyrics,
 * musicDescription, yue2Abc, hunyuanPrompt). For every other field the user is told WHICH
 * field is wrong and shown nothing at it — and when the stored value is not among the
 * control's options, there is no way to clear it. Measured in prod 2026-10-01: 4.4% of
 * media-carrying remixes blocked, against 0.06% on the lane that preceded them. Persisted state is NOT affected — storage rehydrates through `input` and falls back
 * to the default when that fails — which is why the class is invisible to any test that
 * drives the form the way a user does.
 *
 * 🔴 WHICH HOOK IS NOT A STYLE CHOICE, and getting it wrong is a money bug rather than a
 * cosmetic one. `correct` runs on the SERVER parse too. It is safe only when `input` already
 * rejects or normalises the same value, so the hook cannot see it there. Where `input` is
 * permissive — `textDef`'s bare `z.string()`, or any of the six sites ledgered below as
 * `coerce` — a `correct` turns a 400 into a silent normalise-and-bill on a path billed per
 * generation, and the hook must be `coerce`, which trusted writes alone run. That mistake was
 * made and caught in review on the same day, which is why it is pinned here as well as
 * behaviourally.
 *
 * 🔴 A `coerce` IS NOT ENOUGH ON ITS OWN. It is read from the resolution as it stands BEFORE
 * the patch lands, so a single `store.set({ workflow, ecosystem, prompt })` coerces against
 * the OLD family's constraint. Ingestion therefore stages the discriminators first and the
 * values second — see `applyGenerationData` — and `ingestion.test.ts` pins it. `correct` has
 * no such asymmetry: it runs inside resolution, after the patch.
 *
 * This guard is textual on purpose: it answers "does a hook exist", which is the half that
 * goes missing when someone adds a def. Whether the hook is CORRECT is
 * `def-constraint-correction.test.ts`, which drives both paths.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const DEFS = ['src/shared/form-graph/defs.ts', 'src/shared/form-graph/generation/defs.ts'];
const GRAPHS = 'src/shared/form-graph/generation';

/** An output schema that can REFUSE a value the type system allows. */
const CONSTRAINED =
  /\.min\(|\.max\(|\.refine\(|\.includes\(|z\.enum\(|\.length\(|\.nonempty\(|\.gt\(|\.lt\(/;

/**
 * One top-level declaration's source, bounded at the next one.
 *
 * NOT split on `export`: a non-exported declaration is then absorbed into the preceding
 * block, and the absorbed body's hook satisfies the host's assertion. Measured — `sliderDef`
 * swallowed the whole of the private `buildEnumDef`, so deleting `sliderDef`'s own `correct`
 * left this guard green over the most-used def in the generation tree.
 */
function defBlocks(rel: string): Array<{ name: string; body: string }> {
  const lines = readFileSync(path.join(repoRoot, rel), 'utf8').split('\n');
  const starts: Array<{ name: string; i: number }> = [];
  lines.forEach((line, i) => {
    const m = /^(?:export )?(?:const|function|class|interface|type) ([A-Za-z0-9_]+)/.exec(line);
    if (m) starts.push({ name: m[1]!, i });
  });
  return starts.map((s, k) => ({
    name: s.name,
    body: lines.slice(s.i, starts[k + 1]?.i ?? lines.length).join('\n'),
  }));
}

/**
 * The object literal containing offset `at`: back to its unmatched `{`, forward to the match.
 * Brace-matched rather than windowed — a window either misses a hook further down a long def
 * or borrows the neighbouring field's, and the first of those is a false pass.
 */
function enclosingObjectAt(src: string, at: number): { open: number; text: string } | null {
  let depth = 0;
  let open = -1;
  for (let i = at; i >= 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open === -1) return null;
  depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { open, text: src.slice(open, i + 1) };
    }
  }
  return null;
}

function graphFiles(): string[] {
  const files = globSync(`${GRAPHS}/**/*.ts`, { cwd: repoRoot })
    .map((f) => String(f).split(path.sep).join('/'))
    .filter((f) => !f.includes('__tests__'));
  expect(files.length, 'no graph files found — fix this glob').toBeGreaterThan(40);
  return files;
}

/**
 * Defs whose constrained output needs no hook, each with the reason. Empty on purpose — an
 * entry here is a field where a trusted write provably cannot land out of contract, and that
 * claim is hard to make. Prefer adding the hook.
 */
const EXEMPT: Record<string, string> = {};

/**
 * Call sites that REPLACE a spread def's `correct` rather than falling through, each with the
 * reason the override is complete on its own. Not "these are allowed to skip it": each one
 * re-implements the def's whole constraint, which a textual guard cannot verify — so the
 * ledger is where that claim is recorded and reviewed.
 *
 * `image/hub.graph.ts quantity` is deliberately absent. It overrode `quantityDef`'s hook to
 * add a bogo step floor and dropped the CEILING with it, so a quantity above the user's own
 * entitlement dead-submitted; it was fixed to fall through rather than ledgered, which is the
 * outcome this list is meant to push toward.
 */
const COMPLETE_OVERRIDES: Record<string, string> = {
  'audio/ace.graph.ts cfgScale sliderDef':
    'forced to the variant default, which is always in range — a stronger correction than ' +
    'snapping, not a narrower one',
  'audio/ace.graph.ts steps sliderDef':
    'forced to the variant default, which is always in range — a stronger correction than ' +
    'snapping, not a narrower one',
  'image/grok.graph.ts images imagesDef':
    'truncates over its own max (v1.x allows 7, a v2 switch narrows to 3)',
  'model3d/polygen.graph.ts images imagesDef':
    "truncates over its own max (v7's multi-image staging on a v6 switch)",
  'video/wan.graph.ts duration sliderDef':
    'clamps duration to [2, max] itself, where max is workflow-dependent',
};

/**
 * Fields declared INLINE in a graph rather than built from a def, where the constrained
 * output provably cannot refuse a trusted write — each with the reason.
 *
 * This started as a 24-entry list of known holes and is now two, because the other 22 were
 * fixed: 13 enums took `optionFallback`, 3 numerics took `clampCorrect`, 5 permissive-input
 * fields took the `coerce` pair, and krea2's style references slice like `controlNetsDef`.
 *
 * An entry here is a claim that no hook is needed, which is harder to make than adding one.
 * Prefer the hook.
 */
const GRAPH_SITE_EXEMPT: Record<string, string> = {
  'model3d/polygen.graph.ts polygenVersion':
    'its output is `z.enum(...).transform(clamp)` — clamp maps anything unrunnable to v6, so ' +
    'the schema normalises instead of refusing and there is nothing for a hook to heal',

  'workflows/video-enhance.graph.ts scaleFactor':
    'deliberately scope-not-correct, stated at the site: the field is scoped per source ' +
    'dimension so a factor picked for a smaller video never becomes a trusted value on a ' +
    'larger one, and the parse boundary must REFUSE an over-ceiling raw value rather than ' +
    'clamp it',
};

describe('every constrained generation def can heal a trusted write', () => {
  const blocks = DEFS.flatMap((rel) => defBlocks(rel).map((b) => ({ ...b, rel })));

  it('POSITIVE CONTROL — the parser found the defs, not an empty list', () => {
    expect(
      blocks.map((b) => b.name),
      'No def blocks parsed. The file was restructured, so every assertion below is over ' +
        'nothing — fix this parser first.'
    ).toEqual(
      expect.arrayContaining([
        'sliderDef',
        'buildEnumDef',
        'selectDef',
        'imagesDef',
        'textDef',
        'SEED',
      ])
    );
  });

  // The parser's own soundness, which is what went wrong: a block that swallows its
  // neighbour passes on the neighbour's hook. `buildEnumDef` is the one that was absorbed.
  it('POSITIVE CONTROL — no block swallows the next declaration', () => {
    const swallowed = blocks
      .filter((b) => {
        const others = blocks.filter((o) => o !== b && o.rel === b.rel).map((o) => o.name);
        return others.some((n) =>
          new RegExp(`^(?:export )?(?:const|function) ${n}\\b`, 'm').test(b.body)
        );
      })
      .map((b) => `${b.rel} → ${b.name}`);

    expect(
      swallowed,
      'These blocks contain another top-level declaration, so that declaration’s `correct` ' +
        'satisfies this block’s assertion and deleting the block’s own hook goes unnoticed.'
    ).toEqual([]);
  });

  it('every def with a constrained output carries a `correct` or a `coerce`', () => {
    const missing = blocks
      .filter((b) => /output:/.test(b.body) && CONSTRAINED.test(b.body))
      .filter((b) => !/\bcorrect:/.test(b.body) && !/\bcoerce:/.test(b.body))
      .filter((b) => !(b.name in EXEMPT))
      .map((b) => `${b.rel} → ${b.name}`);

    expect(
      missing,
      'These defs can REFUSE a value that a trusted `store.set()` will happily store, so a ' +
        "remix or replay carrying another family's value lands unsubmittable. The footer " +
        'names the field, but most of these controls render no error of their own and ' +
        'cannot clear a value they do not list. Add a `correct` (when `input` already ' +
        'normalises the value) or a `coerce` (when it does not — see the file docblock), or ' +
        'add the def to EXEMPT with the reason it cannot happen.'
    ).toEqual([]);
  });

  it('`textDef` uses `coerce`, NOT `correct` — its input has no length bound', () => {
    const textDef = blocks.find((b) => b.name === 'textDef');
    expect(textDef, 'textDef not found — fix the parser').toBeDefined();

    expect(
      /\bcoerce:/.test(textDef!.body),
      'textDef must truncate in `coerce`. `coerce` runs for trusted writes only, so the ' +
        'server parse still refuses an over-length prompt.'
    ).toBe(true);
    expect(
      /\bcorrect:/.test(textDef!.body),
      'textDef must NOT use `correct`. Its `input` is a bare `z.string()`, so a `correct` ' +
        'also fires on the SERVER parse and turns a 400 into a silent truncate-and-bill on ' +
        'a billed path (`generateFromGraph` takes `z.any()` — the graph IS the contract).'
    ).toBe(false);
  });
});

/**
 * The second half: a call site may narrow a def's correction, but must not REPLACE it.
 * `image/hub.graph.ts` overrode `quantityDef`'s hook to add a bogo step floor and dropped the
 * ceiling with it, so a quantity above the user's own entitlement dead-submitted.
 */
describe('a call site that overrides `correct` falls through to the def', () => {
  /**
   * Every field that spreads a def and then defines its own `correct`, keyed
   * `<rel> <field> <def>`.
   *
   * The field name is part of the key because two overrides of the same def in one file
   * otherwise collapse: `audio/ace.graph.ts` has two `...sliderDef(` overrides, so a third
   * with a genuinely incomplete hook was ledgered by the existing entry.
   */
  function overridingSites(): string[] {
    const found: string[] = [];
    for (const rel of graphFiles()) {
      const lines = readFileSync(path.join(repoRoot, rel), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const spread = /\.\.\.(\w+Def)\(/.exec(lines[i]!);
        if (!spread) continue;
        // The override, if any, sits in the same object literal — a few lines down.
        const window = lines.slice(i, i + 14).join('\n');
        if (!/\bcorrect:/.test(window)) continue;
        // Falling through is the whole point: `base.correct?.(…)`.
        if (/\w+\.correct\?\.\(/.test(window)) continue;
        const field =
          [
            ...lines
              .slice(0, i + 1)
              .join('\n')
              .matchAll(/\.field\(\s*'([^']+)'/g),
          ].pop()?.[1] ?? '?';
        found.push(`${rel.replace(`${GRAPHS}/`, '')} ${field} ${spread[1]}`);
      }
    }
    return [...new Set(found)];
  }

  it('no field replaces a spread def’s `correct` without being ledgered', () => {
    const offenders = overridingSites().filter((k) => !(k in COMPLETE_OVERRIDES));

    expect(
      offenders,
      'These spread a def and then define their own `correct`, which REPLACES the def’s ' +
        'rather than adding to it — so the def’s own bound is silently dropped and a ' +
        'trusted write past it dead-submits. Either fall through (`const base = <def>(…); ' +
        '… correct: (v) => <narrow case> ?? base.correct?.(v)`), or handle the def’s whole ' +
        'constraint in the override and record it in COMPLETE_OVERRIDES with the reason.'
    ).toEqual([]);
  });

  // A stale ledger entry is an exemption nobody is checking any more.
  it('every COMPLETE_OVERRIDES entry still names a real override', () => {
    const seen = new Set(overridingSites());

    expect(
      Object.keys(COMPLETE_OVERRIDES).filter((k) => !seen.has(k)),
      'These ledger entries name an override that no longer exists — either it now falls ' +
        'through (good: delete the entry) or the field was removed.'
    ).toEqual([]);
  });
});

/**
 * The third half, and the one the first two could not see: a field declared INLINE in a graph
 * rather than built from a def. `video/hub.graph.ts` declares its own `quantity` with the same
 * `min(1).max(max)` ceiling as `quantityDef` and had no hook at all, one file over from the
 * `image/hub.graph.ts` override this guard was written for.
 */
describe('an inline graph field with a constrained output is decided, not inherited', () => {
  const scanned: string[] = [];

  function inlineSites(): string[] {
    scanned.length = 0;
    const found: string[] = [];
    for (const rel of graphFiles()) {
      if (rel === `${GRAPHS}/defs.ts`) continue;
      const src = readFileSync(path.join(repoRoot, rel), 'utf8');
      // NOT anchored to line start: a compact field declared on one line
      // (`{ input: …, output: …, default: … }`) escaped that, and a new unhooked field is
      // exactly what this is for.
      for (const m of src.matchAll(/\boutput:/g)) {
        const at = m.index!;
        const obj = enclosingObjectAt(src, at);
        if (!obj) continue;
        // `refine: (output: z.ZodString) => …` names a PARAMETER, not a field. Tell them
        // apart by paren depth between the object's brace and here: a parameter list is
        // still open, a field's value is not.
        const lead = src.slice(obj.open, at);
        const depth = (lead.match(/\(/g) ?? []).length - (lead.match(/\)/g) ?? []).length;
        if (depth > 0) continue;
        const schema = src
          .slice(at, at + 400)
          .split('\n')
          .slice(0, 9)
          .join(' ');
        if (!CONSTRAINED.test(schema)) continue;
        scanned.push(rel);
        if (/\bcorrect:|\bcoerce:/.test(obj.text)) continue;

        const before = src.slice(0, at);
        const fieldM = [...before.matchAll(/\.field\(\s*'([^']+)'/g)].pop();
        const constM = [...before.matchAll(/^(?:export )?const ([A-Za-z0-9_]+)\s*[:=]/gm)].pop();
        const name =
          (fieldM && constM
            ? fieldM.index! > constM.index!
              ? fieldM[1]
              : constM[1]
            : fieldM?.[1] ?? constM?.[1]) ?? '?';
        found.push(`${rel.replace(`${GRAPHS}/`, '')} ${name}`);
      }
    }
    return [...new Set(found)];
  }

  it('POSITIVE CONTROL — the scan reaches the inline constrained fields', () => {
    inlineSites();
    // Counts fields SCANNED, not fields unhooked. The unhooked count is meant to fall to
    // the exempt pair as holes are closed, so asserting on it would turn fixing them into a
    // failure — and a broken brace matcher would then read as success.
    expect(
      scanned.length,
      'the inline scan reached almost nothing — the matcher or the glob broke, and the' +
        ' assertion below is passing over an empty list'
    ).toBeGreaterThan(20);
  });

  it('no inline constrained field is unhooked and unexplained', () => {
    const offenders = inlineSites().filter((k) => !(k in GRAPH_SITE_EXEMPT));

    expect(
      offenders,
      'These declare a constrained `output` inline with no `correct`/`coerce`, so a trusted ' +
        'write past the bound dead-submits. Add the hook — `coerce` if the field’s own ' +
        '`input` is permissive, `correct` if it carries the same bound — or add the field to ' +
        'GRAPH_SITE_EXEMPT with the reason a hook is not needed.'
    ).toEqual([]);
  });

  it('every GRAPH_SITE_EXEMPT entry still names an unhooked field', () => {
    const seen = new Set(inlineSites());

    expect(
      Object.keys(GRAPH_SITE_EXEMPT).filter((k) => !seen.has(k)),
      'These ledger entries name a field that is no longer unhooked (good: delete the ' +
        'entry) or no longer exists.'
    ).toEqual([]);
  });
});
