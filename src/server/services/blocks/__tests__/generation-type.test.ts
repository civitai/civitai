import { describe, expect, it } from 'vitest';

import {
  blockPassThroughStepBodySchema,
  PASS_THROUGH_TYPE_MAX_CHARS,
} from '~/server/schema/blocks/workflow.schema';
import {
  BLOCK_AUTHOR_FEE_PLATFORM_CONFIG,
  resolveBlockAuthorFeeParams,
  type BlockAuthorFeeConfig,
} from '../author-fee';
import {
  BLOCK_GENERATION_COARSE_TYPES,
  BLOCK_GENERATION_TYPES,
  BLOCK_IMAGE_GENERATION_SUBTYPES,
  BLOCK_PASS_THROUGH_COARSE_TYPE,
  BLOCK_PASS_THROUGH_SUBTYPE_MAX_CHARS,
  BLOCK_WORKFLOW_KIND_GENERATION_TYPES,
  blockGenerationCoarseType,
  composeBlockGenerationType,
  CUSTOM_COMFY_GENERATION_SUBTYPES,
  isBlockGenerationType,
  resolveBlockGenerationType,
} from '../generation-type';
import { getRecipe, REGISTERED_RECIPE_IDS } from '../recipes';
import { getStep, listRegisteredSteps, REGISTERED_STEP_IDS } from '../steps';
import { BLOCK_IMAGE_WORKFLOW_TYPES } from '../workflow.service';

/**
 * App Blocks GENERATION TYPE resolution — the app-facing key persisted on
 * `block_spend_attribution.generation_type`.
 *
 * NOTE ON WHAT THESE ARE. Three populations, deliberately labelled apart:
 *
 *   - The PASS-THROUGH assertions (`step:<$type>`, and the shape bound on the one
 *     open axis) are REGRESSION coverage for a SECOND widening: a pass-through
 *     submit used to resolve to `null` and record nothing. They are marked out in
 *     their own two describes — but NOT ALL OF THEM ARE REGRESSION COVERAGE, and
 *     rather than enumerate the exceptions here (a central list of them has now
 *     been wrong TWICE: first claiming all of them were red at base, then naming
 *     three when the answer was five), each such test says so AT ITS OWN `it(`,
 *     the way the two `INVARIANT GUARD` tests below already do. Grep
 *     `HOLDS AT BASE` for the population.
 *
 *   - The SUBTYPE assertions (everything asserting a value with a colon in it,
 *     plus the shape bounds on `isBlockGenerationType`) are REGRESSION coverage
 *     for the widening: they are red on the pre-widening commit, where the
 *     resolver returned a bare `textToImage` / `customComfy` and the validator
 *     was a flat `Array.includes`.
 *   - The COARSE assertions (a step id resolving to its registry id, junk
 *     degrading to null) predate the widening. They are kept because they pin
 *     what must NOT change, and they are not counted as regression coverage for
 *     this change.
 *   - Two tests are labelled INVARIANT GUARD. Nothing has ever violated them.
 *     `no registry id contains a colon` passes on either tree; the step-id/kind-key
 *     collision test is an invariant guard PLUS one assertion that is red at base
 *     (`BLOCK_WORKFLOW_KIND_GENERATION_TYPES` gained `step` here), and its title
 *     and body say so rather than claiming the whole test would pass at base.
 *
 * Expected values are pinned as LITERALS throughout — never re-derived from the
 * function under test, and never from the registry entry the assertion is about.
 */

/**
 * A single space, BUILT rather than typed inside a quote.
 *
 * Purely for REVIEWER LEGIBILITY, and only where the space is at an EDGE: a
 * fixture like `' imageGen'` or `'imageGen '` reads identically to the un-spaced
 * string in a diff, so the assertion's whole point is invisible. Mid-string spaces
 * (`'foo bar'`) are legible as written and stay literal.
 *
 * ⚠️ NOT a formatter defence — Prettier does not rewrite string-literal contents,
 * and a trailing-whitespace trimmer works on line ends, not before a closing
 * quote. An earlier draft of this comment claimed that and it is not true.
 */
const SP = String.fromCharCode(32);

// ─────────────────────────────────────────────────────────────────────────────
// THE VALUE GRAMMAR
// ─────────────────────────────────────────────────────────────────────────────

describe('the value grammar — <coarse>:<subtype>, coarse before the FIRST colon', () => {
  // 🔴 THE LOAD-BEARING RULE OF THE WHOLE WIDENING. The per-generation-type author
  // fee keys on the COARSE key and must keep working unchanged as the subtype axis
  // grows. If these go red, that feature silently stops finding its rate — and it
  // is no longer hypothetical: `author-fee.ts` (slice 1, dark) resolves its
  // parameters through `blockGenerationCoarseType` and labels its counters with the
  // result.

  it('the coarse key is exactly these six', () => {
    // Literal, not derived. Widening this set is a wire-contract decision and a
    // fee-table decision; it must not happen by accident.
    //
    // 🔴 `step` IS THE FIFTH, ADDED WITH THE PASS-THROUGH ARM. It is a new FEE
    // GROUP, which is why it belongs in a literal a reviewer has to change by
    // hand: every `kind:'step'` submit carrying a bare `$type` rather than a
    // registry id groups under it, and it exists so that such a submit can never
    // group under `textToImage` (which is also a real orchestrator `$type`).
    //
    // 🔴 `h3-video` IS THE SIXTH, AND IT IS A NEW FEE GROUP. Registering a step
    // widens this list automatically, so this literal is the only place a human
    // has to agree. The decision that was checked before widening it: an app
    // whose `byType` carries no entry for this coarse key falls through to
    // `config.default` in `resolveBlockAuthorFeeParams` — it does not throw and
    // it does not silently resolve to a zero fee. So an existing app's default
    // fee applies to a video generation on the day this ships, and an author
    // who wants a different rate for video adds a `byType` override.
    expect([...BLOCK_GENERATION_COARSE_TYPES].sort()).toEqual(
      ['chat-completion', 'convert-image', 'customComfy', 'h3-video', 'step', 'textToImage'].sort()
    );
  });

  it('decomposes every shipped value to its coarse key', () => {
    expect(blockGenerationCoarseType('textToImage')).toBe('textToImage');
    expect(blockGenerationCoarseType('textToImage:txt2img')).toBe('textToImage');
    expect(blockGenerationCoarseType('textToImage:img2img')).toBe('textToImage');
    expect(blockGenerationCoarseType('textToImage:img2img-edit')).toBe('textToImage');
    expect(blockGenerationCoarseType('customComfy')).toBe('customComfy');
    expect(blockGenerationCoarseType('customComfy:inline')).toBe('customComfy');
    expect(blockGenerationCoarseType('customComfy:seamless-pano-360')).toBe('customComfy');
    expect(blockGenerationCoarseType('convert-image')).toBe('convert-image');
    expect(blockGenerationCoarseType('chat-completion')).toBe('chat-completion');
    expect(blockGenerationCoarseType('step')).toBe('step');
    expect(blockGenerationCoarseType('step:imageGen')).toBe('step');
    // 🔴 THE FEE-GROUPING PROPERTY THE NAMESPACE EXISTS FOR, stated as a
    // decomposition: a pass-through submit naming a `$type` that happens to equal
    // a kind key or a registry id STILL groups under `step`, never under that
    // key's own fee group.
    expect(blockGenerationCoarseType('step:textToImage')).toBe('step');
    expect(blockGenerationCoarseType('step:customComfy')).toBe('step');
    expect(blockGenerationCoarseType('step:convert-image')).toBe('step');
  });

  it('refuses to decompose a value this build does not recognise — null, never a guess', () => {
    // A fee must never be keyed off a string that was never a generation type.
    expect(blockGenerationCoarseType('videoToVideo:fast')).toBeNull();
    expect(blockGenerationCoarseType('textToImage:not-a-class')).toBeNull();
    expect(blockGenerationCoarseType('txt2img')).toBeNull();
    expect(blockGenerationCoarseType(null)).toBeNull();
    expect(blockGenerationCoarseType(7)).toBeNull();
  });

  it('never emits a bare subtype — that would destroy the coarse key the fee looks up', () => {
    // The single most damaging spelling mistake available here. `txt2img` and
    // `inline` are real subtypes and plausible-looking values; neither is a
    // legal stored value on its own.
    expect(isBlockGenerationType('txt2img')).toBe(false);
    expect(isBlockGenerationType('img2img')).toBe(false);
    expect(isBlockGenerationType('img2img-edit')).toBe(false);
    expect(isBlockGenerationType('inline')).toBe(false);
    expect(isBlockGenerationType('seamless-pano-360')).toBe(false);
  });

  it('every value carries AT MOST ONE colon — the subtype is colon-free', () => {
    // The graph spells the edit class `img2img:edit`; the stored subtype is
    // `img2img-edit` precisely so this rule holds. A second colon would still
    // decompose under "before the FIRST colon", but the value would stop being
    // a plain two-field record — refuse it rather than invent an escaping rule.
    expect(isBlockGenerationType('textToImage:img2img:edit')).toBe(false);
    expect(isBlockGenerationType('customComfy:inline:extra')).toBe(false);
    for (const value of BLOCK_GENERATION_TYPES) {
      expect(value.split(':').length).toBeLessThanOrEqual(2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// textToImage — the IMAGE WORKFLOW CLASS sub-axis
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveBlockGenerationType — textToImage carries the image workflow class', () => {
  // 🔴 THE CLASS IS NOT DERIVABLE FROM THE BODY. A body with a source image maps
  // to `img2img` on an SD-family ecosystem and to `img2img:edit` on an
  // edit-capable one; the discriminator is the CHECKPOINT'S ECOSYSTEM, resolved
  // inside `buildImageWorkflowInput`. So the authoritative class is passed in —
  // the router reads back the value that builder stamped on the graph input.

  it('resolves txt2img to the literal "textToImage:txt2img"', () => {
    expect(
      resolveBlockGenerationType(
        { kind: 'textToImage', modelId: 7 },
        { imageWorkflowType: 'txt2img' }
      )
    ).toBe('textToImage:txt2img');
  });

  it('resolves img2img (SD-family) to the literal "textToImage:img2img"', () => {
    expect(
      resolveBlockGenerationType(
        { kind: 'textToImage', modelId: 7, sourceImage: { url: 'x', width: 64, height: 64 } },
        { imageWorkflowType: 'img2img' }
      )
    ).toBe('textToImage:img2img');
  });

  it('resolves the graph\'s "img2img:edit" to the literal "textToImage:img2img-edit"', () => {
    // 🔴 THE TRANSLATION, pinned from both sides. The graph vocabulary carries a
    // colon; the stored subtype must not.
    const resolved = resolveBlockGenerationType(
      { kind: 'textToImage', modelId: 7, sourceImages: [{ url: 'x', width: 64, height: 64 }] },
      { imageWorkflowType: 'img2img:edit' }
    );
    expect(resolved).toBe('textToImage:img2img-edit');
    expect(resolved).not.toBe('textToImage:img2img:edit');
    expect(resolved).not.toBe('textToImage:img2img');
  });

  it('degrades to the bare coarse key when no class is supplied — never a guessed variant', () => {
    // A caller with no authoritative class (any non-router caller) gets the
    // shallower TRUE value, not a variant inferred from the body. Inferring
    // would be a second copy of a rule that lives in
    // `resolveBlockImageWorkflowType`, and the two could disagree.
    expect(resolveBlockGenerationType({ kind: 'textToImage', modelId: 7 })).toBe('textToImage');
    expect(
      resolveBlockGenerationType(
        { kind: 'textToImage', modelId: 7, sourceImage: { url: 'x', width: 64, height: 64 } },
        {}
      )
    ).toBe('textToImage');
  });

  it('degrades to the bare coarse key for an UNRECOGNISED class — not the raw string', () => {
    for (const hostile of ['video2video', 'txt2imgg', 'toString', '', 7, null, {}, ['txt2img']]) {
      expect(
        resolveBlockGenerationType({ kind: 'textToImage', modelId: 7 }, {
          imageWorkflowType: hostile,
        } as never)
      ).toBe('textToImage');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// customComfy — the ARM + RECIPE sub-axis
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveBlockGenerationType — customComfy carries the arm and the recipe', () => {
  it('resolves the recipe arm to "customComfy:<registered recipe id>"', () => {
    expect(
      resolveBlockGenerationType({
        kind: 'customComfy',
        recipe: 'seamless-pano-360',
        params: {},
      })
    ).toBe('customComfy:seamless-pano-360');
  });

  it('resolves the SECOND registered recipe too — not just the first', () => {
    // Two fixtures with distinct values, so an implementation that hardcoded one
    // recipe id cannot pass both.
    expect(
      resolveBlockGenerationType({
        kind: 'customComfy',
        recipe: 'starter-comfy-txt2img',
        params: {},
      })
    ).toBe('customComfy:starter-comfy-txt2img');
  });

  it('resolves the recipe arm with an EXPLICIT mode:"recipe" identically', () => {
    // `mode` is `.optional()` on the recipe arm — an absent `mode` IS a recipe
    // body (every deployed app sends one). Both spellings must agree.
    expect(
      resolveBlockGenerationType({
        kind: 'customComfy',
        mode: 'recipe',
        recipe: 'seamless-pano-360',
        params: {},
      })
    ).toBe('customComfy:seamless-pano-360');
  });

  it('resolves the INLINE arm to the literal "customComfy:inline"', () => {
    // An inline graph is app-authored and has no stable server-side identity to
    // key a fee on — one bucket, by design.
    expect(
      resolveBlockGenerationType({
        kind: 'customComfy',
        mode: 'inline',
        workflow: {},
        params: {},
      })
    ).toBe('customComfy:inline');
  });

  it('does NOT interpolate an unregistered recipe id — degrades to the bare coarse key', () => {
    // 🔴 THE OPEN-ENDED HALF OF THE VALUE SPACE. Interpolating a registry id
    // into the value is the thing that made a flat membership test insufficient,
    // and the bound must not have been quietly dropped with it. The wire schema
    // already rejects an unregistered id (`z.enum(REGISTERED_RECIPE_IDS)`), so
    // this is defense in depth — the direction in which a wrong value is worse
    // than a shallow one.
    const resolved = resolveBlockGenerationType({
      kind: 'customComfy',
      recipe: 'not-a-real-recipe',
      params: {},
    });
    expect(resolved).toBe('customComfy');
    expect(resolved).not.toBe('customComfy:not-a-real-recipe');
  });

  it('rejects a PROTOTYPE KEY as a recipe id (the dispatch-table fail-open trap, widened)', () => {
    // `getRecipe` indexes a plain object literal exactly as `getStep` does, so a
    // prototype key is TRUTHY there — a `getRecipe(x) ? x : null` guard would
    // interpolate `toString` onto a money row. The widening did not relax this:
    // the recipe id is bounded by an ARRAY membership test, same as the step id.
    expect(getRecipe('toString')).toBeTruthy(); // the hazard is real, not hypothetical
    for (const key of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(resolveBlockGenerationType({ kind: 'customComfy', recipe: key, params: {} })).toBe(
        'customComfy'
      );
    }
  });

  it('does not let an UNKNOWN arm read a recipe off the body', () => {
    // A third `mode` is not a recipe body. The wire schema rejects it; reading
    // `recipe` anyway would be guessing, so the coarse key is the honest answer.
    expect(
      resolveBlockGenerationType({
        kind: 'customComfy',
        mode: 'streaming',
        recipe: 'seamless-pano-360',
        params: {},
      })
    ).toBe('customComfy');
  });

  it('does not let a kind key or a step id masquerade as a recipe id', () => {
    for (const hostile of ['inline-x', 'textToImage', 'customComfy', 'convert-image']) {
      expect(resolveBlockGenerationType({ kind: 'customComfy', recipe: hostile, params: {} })).toBe(
        'customComfy'
      );
    }
  });

  it('degrades to the coarse key for a non-string / absent recipe', () => {
    for (const hostile of [undefined, null, 7, {}, ['seamless-pano-360']]) {
      expect(resolveBlockGenerationType({ kind: 'customComfy', recipe: hostile, params: {} })).toBe(
        'customComfy'
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// kind: step — UNCHANGED by the widening (pre-existing behaviour)
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveBlockGenerationType — kind: step resolves to the STEP ID, not the orchestrator type', () => {
  // 🔴 THE DESIGN RISK THIS PR IS MOST LIKELY TO GET BACKWARDS, pinned with
  // literals on BOTH sides: the value written is the registry id (a permanent
  // public wire commitment), and it is specifically NOT the entry's
  // `orchestratorType` (the orchestrator's internal spelling, free to change).
  it('resolves convert-image to "convert-image" and NOT "convertImage"', () => {
    const resolved = resolveBlockGenerationType({
      kind: 'step',
      step: 'convert-image',
      params: {},
    });
    expect(resolved).toBe('convert-image');
    expect(resolved).not.toBe('convertImage');
  });

  it('resolves chat-completion to "chat-completion" and NOT "chatCompletion"', () => {
    const resolved = resolveBlockGenerationType({
      kind: 'step',
      step: 'chat-completion',
      params: {},
    });
    expect(resolved).toBe('chat-completion');
    expect(resolved).not.toBe('chatCompletion');
  });

  it('a step id is a COARSE key and carries NO subtype', () => {
    // A depth decision, not an omission: a step's own params are a third level
    // and already ride on the step invocation row's `detail`. The validator has
    // to refuse a subtype here rather than wave one through as "some future
    // step subtype" — an empty allowed-subtype set, not a wildcard.
    expect(isBlockGenerationType('convert-image')).toBe(true);
    expect(isBlockGenerationType('convert-image:png')).toBe(false);
    expect(isBlockGenerationType('chat-completion:gpt')).toBe(false);
    expect(isBlockGenerationType('convert-image:')).toBe(false);
    // 🔴 And specifically NOT some OTHER coarse key's subtype set. Asserting
    // only invented subtypes (`png`, `gpt`) cannot see the likeliest wrong
    // implementation — a fallthrough returning the customComfy or image set
    // instead of the empty one — because neither invented value is in either
    // set, so the mutant would survive a fully green suite. These are.
    expect(isBlockGenerationType('convert-image:inline')).toBe(false);
    expect(isBlockGenerationType('convert-image:seamless-pano-360')).toBe(false);
    expect(isBlockGenerationType('chat-completion:txt2img')).toBe(false);
  });

  it('the two spellings really are different for every registered step — otherwise the two assertions above are vacuous', () => {
    // Guards the guards. If some entry ever declared `orchestratorType` equal to
    // its registry id, the `not.toBe` assertions above would pass for free and
    // stop discriminating. Enumerates the REAL population rather than a list.
    const pairs = listRegisteredSteps().map(([id, step]) => [id, step.orchestratorType]);
    expect(pairs.length).toBeGreaterThan(0);
    for (const [id, orchestratorType] of pairs) {
      expect(id).not.toBe(orchestratorType);
    }
    // And the orchestrator spelling is never itself an accepted value.
    for (const [, orchestratorType] of pairs) {
      expect(isBlockGenerationType(orchestratorType)).toBe(false);
    }
  });

  it('rejects an UNREGISTERED step id — null, not the raw string', () => {
    expect(
      resolveBlockGenerationType({ kind: 'step', step: 'not-a-real-step', params: {} })
    ).toBeNull();
  });

  it('rejects a prototype key as a step id (the dispatch-table fail-open trap)', () => {
    // `getStep` indexes a plain object literal, so a prototype key is TRUTHY
    // there — a `getStep(x) ? x : null` guard would let it through and stamp it
    // on a money row. The resolver must not be built that way.
    expect(getStep('toString')).toBeTruthy(); // the hazard is real, not hypothetical
    expect(resolveBlockGenerationType({ kind: 'step', step: 'toString', params: {} })).toBeNull();
    expect(
      resolveBlockGenerationType({ kind: 'step', step: 'constructor', params: {} })
    ).toBeNull();
  });

  it('does not let a kind key masquerade as a step id', () => {
    // `{ kind: 'step', step: 'textToImage' }` must not report an image
    // generation. The wire schema rejects this body; a wrong value here would be
    // worse than a null one, so the resolver checks the step arm against the
    // step ids only.
    expect(
      resolveBlockGenerationType({ kind: 'step', step: 'textToImage', params: {} })
    ).toBeNull();
    expect(
      resolveBlockGenerationType({ kind: 'step', step: 'textToImage:txt2img', params: {} })
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// kind: step, PASS-THROUGH arm — `step:<orchestrator $type>` (the ONE open axis)
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveBlockGenerationType — the pass-through arm records step:<$type>', () => {
  /**
   * A `$type` the LIVE orchestrator has and `stepRegistry` does not.
   *
   * 🔴 A REAL ONE, measured against
   * `https://orchestration.civitai.com/openapi/v2-consumers.json`
   * (`WorkflowStepTemplate.discriminator.mapping`, 50 entries on 2026-09-17) —
   * not a plausible-looking invention, so these assertions are about a value a
   * submit can actually carry.
   */
  const PT_TYPE = 'imageBackgroundRemoval';

  /** A minimal pass-through body: `step` ABSENT is the arm's discriminator. */
  const ptBody = (over: Record<string, unknown> = {}) => ({
    kind: 'step',
    $type: PT_TYPE,
    input: { prompt: 'a cat' },
    maxBuzz: 20,
    ...over,
  });

  it('resolves a pass-through submit to the literal "step:imageBackgroundRemoval"', () => {
    // 🔴 THE REGRESSION. Before this arm existed in the resolver, EVERY
    // pass-through generation recorded NULL — an unbackfillable hole in a
    // fee-bearing column, invisible because `null` is a legitimate return for a
    // body this build cannot type.
    expect(resolveBlockGenerationType(ptBody())).toBe('step:imageBackgroundRemoval');
  });

  it('resolves a SECOND distinct $type too — not just the first', () => {
    // Two fixtures with distinct values, so an implementation that hardcoded one
    // `$type` (or returned the coarse key regardless) cannot pass both.
    expect(resolveBlockGenerationType(ptBody({ $type: 'imageGen' }))).toBe('step:imageGen');
  });

  it('🔴 NAMESPACES a $type that COLLIDES with a kind key — never bare', () => {
    // 🔴 THE MEASUREMENT THE WHOLE DESIGN RESTS ON. `textToImage`, `customComfy`
    // and `imageGen` are ALL real keys of the live `$type` mapping, so a bare
    // `$type` in this column would make a pass-through submit indistinguishable
    // from a genuine `kind:'textToImage'` submit — and the per-generation-type
    // author fee would price it as one. Asserted from both sides.
    const resolved = resolveBlockGenerationType(ptBody({ $type: 'textToImage' }));
    expect(resolved).toBe('step:textToImage');
    expect(resolved).not.toBe('textToImage');
    expect(blockGenerationCoarseType(resolved)).toBe('step');
    expect(blockGenerationCoarseType(resolved)).not.toBe('textToImage');

    const comfy = resolveBlockGenerationType(ptBody({ $type: 'customComfy' }));
    expect(comfy).toBe('step:customComfy');
    expect(comfy).not.toBe('customComfy');
    expect(blockGenerationCoarseType(comfy)).toBe('step');
  });

  it('🔴 NAMESPACES a $type that collides with a REGISTERED STEP ID — never bare', () => {
    // The registry arm writes a bare `convert-image`. A pass-through submit
    // naming that string as its `$type` must not be recorded as the registered
    // capability, whose controls (bounded params, moderation posture, resource
    // policy) it did NOT run.
    const resolved = resolveBlockGenerationType(ptBody({ $type: 'convert-image' }));
    expect(resolved).toBe('step:convert-image');
    expect(resolved).not.toBe('convert-image');
    expect(blockGenerationCoarseType(resolved)).toBe('step');
  });

  it('records the ORCHESTRATOR spelling verbatim — this arm has no app-facing id', () => {
    // 🔴 THE ONE DELIBERATE EXCEPTION to the APP-FACING-ID-NEVER-`$type` rule,
    // pinned so it cannot be "fixed" back into a registry lookup: the
    // pass-through arm has no registry id at all, and `convertImage` is exactly
    // the spelling the app submitted. The `step:` prefix is what keeps the
    // orchestrator vocabulary distinguishable from the registry one in the value.
    expect(resolveBlockGenerationType(ptBody({ $type: 'convertImage' }))).toBe('step:convertImage');
    expect(resolveBlockGenerationType(ptBody({ $type: 'chatCompletion' }))).toBe(
      'step:chatCompletion'
    );
    // And the registry arm is UNCHANGED by this — still the id, never the type.
    expect(resolveBlockGenerationType({ kind: 'step', step: 'convert-image', params: {} })).toBe(
      'convert-image'
    );
  });

  it('DEGRADES to the bare "step" for a $type the SHAPE bound refuses — never a raw value', () => {
    // 🔴 EVERY ONE OF THESE IS WIRE-LEGAL. `$type` is `z.string().min(1).max(64)`
    // with no character class, so a colon, a space, a newline and a 64-char
    // string all parse — which is what makes this degrade path REACHABLE rather
    // than defensive (pinned against the real schema in the SEAM test below).
    // A shallower TRUE value beats a wrong one: the row still records that a
    // pass-through submit happened, and the fee still finds its coarse key.
    for (const hostile of [
      'a:b', // a second colon would break the two-field grammar
      'textToImage:txt2img', // …and would forge a value under another fee group
      'foo bar',
      'foo\nbar',
      'imageGen\n',
      '\timageGen',
      'imageGen/../x',
      `${SP}imageGen`,
      `imageGen${SP}`,
      'ünïcode',
      'a'.repeat(65), // one past the cap
      '',
    ]) {
      expect(resolveBlockGenerationType(ptBody({ $type: hostile }))).toBe('step');
    }
    // Exactly AT the cap still carries its subtype — the boundary, from both
    // sides, so an off-by-one in either direction is visible.
    const atCap = 'a'.repeat(64);
    expect(resolveBlockGenerationType(ptBody({ $type: atCap }))).toBe(`step:${atCap}`);
  });

  // HOLDS AT BASE (a bound, not regression coverage): the pre-change resolver
  // never read `$type` at all, so every fixture here already returned `null`
  // there. It is kept because this arm's own guard is what has to keep it true.
  it('a body with NEITHER a step id NOR a string $type stays NULL, not a bare "step"', () => {
    // 🔴 THE CONTRACT THIS ARM MUST NOT WEAKEN. `step === undefined` is the
    // pass-through DISCRIMINATOR, but a body carrying neither field matches
    // NEITHER arm of the wire schema, and recording it as a pass-through submit
    // would be inventing a fact. (This is the same expectation the junk table
    // below pins for `{ kind: 'step', params: {} }`; asserted here too because
    // it is this arm's guard that has to keep it true.)
    for (const hostile of [undefined, null, 7, {}, ['imageGen'], true]) {
      expect(resolveBlockGenerationType({ kind: 'step', params: {}, $type: hostile })).toBeNull();
    }
    expect(resolveBlockGenerationType({ kind: 'step', params: {} })).toBeNull();
  });

  it('the arm discriminator is `step === undefined` EXACTLY — not falsy, not non-string', () => {
    // 🔴 THE MUTATION THIS EXISTS FOR, and every fixture above is blind to it.
    // `if (!step)` / `if (step == null)` / `if (typeof step !== 'string')` all look
    // like tidier spellings of the same guard, and all three route a body with a
    // JUNK `step` into the pass-through arm. Paired with a perfectly good `$type`
    // that records `step:<$type>` for a body whose contract answer is `null` —
    // invented from a body that matches NEITHER wire arm. The junk table's
    // `step: 7` / `step: null` cases cannot see it, because they carry no `$type`
    // and so hit the `typeof $type !== 'string'` guard either way.
    for (const badStep of [7, null, '', {}, false, ['convert-image']]) {
      expect(
        resolveBlockGenerationType({ kind: 'step', step: badStep, $type: 'imageGen', params: {} })
      ).toBeNull();
    }
    // An OWN key whose value is `undefined` IS the pass-through arm — the wire
    // schema's discriminator is the VALUE, not the key's absence, so a resolver
    // "tidied" to `'step' in body` would send every own-key pass-through body back
    // to NULL with the router suite still green.
    expect(
      resolveBlockGenerationType({ kind: 'step', step: undefined, $type: 'imageGen', maxBuzz: 1 })
    ).toBe('step:imageGen');
  });

  // HOLDS AT BASE (a bound, not regression coverage): the pre-change resolver had
  // only the registry arm, so this was true for free. It pins arm PRECEDENCE now
  // that there are two arms to get the wrong way round.
  it('a REGISTRY body carrying a stray $type still resolves to its STEP ID', () => {
    // Arm precedence, pinned: the registry id wins. Unreachable through the wire
    // (both arms are `.strict()`, so a body naming both is rejected by both), but
    // this resolver's whole posture is defence-in-depth over `unknown`, and
    // swapping the two arms would otherwise survive the suite.
    expect(
      resolveBlockGenerationType({
        kind: 'step',
        step: 'convert-image',
        $type: 'imageGen',
        params: {},
      })
    ).toBe('convert-image');
  });

  it('accepts a prototype-key-shaped $type — and that is a DECISION, not an oversight', () => {
    // The prototype-key discipline elsewhere in this file is about LOOKUPS: a
    // `getStep('toString')` / `getRecipe('toString')` index returns a truthy
    // function and would sail through a truthiness guard. Nothing indexes an
    // object by THIS segment — the bound is a shape test — and the fee keys on
    // the coarse `step`, so `step:toString` is simply an honest record of a
    // `$type` string the app sent. Pinned so the behaviour is deliberate.
    expect(resolveBlockGenerationType(ptBody({ $type: 'toString' }))).toBe('step:toString');
    expect(isBlockGenerationType('step:toString')).toBe(true);
    // The coarse position is a MEMBERSHIP test and still refuses one.
    expect(isBlockGenerationType('toString:imageGen')).toBe(false);
  });

  it('never returns a value its own validator rejects, over hostile $types', () => {
    // The producer→bound seam on the open arm: whatever comes out is accepted by
    // the test the write side re-runs.
    for (const hostile of ['imageGen', 'a:b', '', 'a'.repeat(65), 'toString', 'foo bar', '.']) {
      const out = resolveBlockGenerationType(ptBody({ $type: hostile }));
      expect(out).not.toBeNull();
      expect(isBlockGenerationType(out)).toBe(true);
    }
  });
});

describe('the pass-through SHAPE bound is the only bound on that axis', () => {
  it('accepts the bare coarse key and a shape-valid subtype', () => {
    expect(isBlockGenerationType('step')).toBe(true);
    expect(isBlockGenerationType('step:imageGen')).toBe(true);
    expect(isBlockGenerationType('step:imageBackgroundRemoval')).toBe(true);
    // The class admits the three punctuation characters orchestrator ids use.
    expect(isBlockGenerationType('step:convert-image')).toBe(true);
    expect(isBlockGenerationType('step:a.b')).toBe(true);
    expect(isBlockGenerationType('step:a_b')).toBe(true);
    // 🔴 AND A DIGIT, which every other fixture in this file lacks. Without one,
    // narrowing the class to `[A-Za-z._-]` SURVIVES a fully green suite, and the
    // next upstream `$type` carrying a digit silently degrades to a bare `step`.
    expect(isBlockGenerationType('step:imageGen2')).toBe(true);
    expect(isBlockGenerationType('step:sd35')).toBe(true);
    expect(isBlockGenerationType('step:0')).toBe(true);
  });

  it('admits EVERY character of the class and NO other printable ASCII', () => {
    // 🔴 THE CLASS AS A WHITELIST, ENUMERATED — because sampling its complement
    // leaves most of the widening family alive: adding `+ ~ % @ # * , ; " ( ) [ ] |`
    // to the class turns no other test in this file red — verified by extracting
    // every string fixture in the file; none contains any of them. (NOT "anything
    // else", which an earlier draft claimed: a space, `\t`, `\n`, `/` and `\` are
    // pinned by `refuses whitespace, control characters and non-ASCII`, and `:` by
    // `refuses a SECOND colon`. Named rather than positional — a draft said "the
    // next test" and then a test was inserted between them.) Both directions,
    // mechanically, so the guard is as wide as its name.
    const allowed = new Set(
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'.split('')
    );
    const admitted: string[] = [];
    const refused: string[] = [];
    for (let code = 0x20; code <= 0x7e; code += 1) {
      const ch = String.fromCharCode(code);
      (isBlockGenerationType(`step:${ch}`) ? admitted : refused).push(ch);
    }
    // 26 + 26 + 10 + 3 = 65 allowed; 95 printable ASCII (0x20–0x7E), so 30 are
    // refused. Both counts literal, so a class that widens OR narrows is visible
    // as a number rather than only as a set difference.
    expect(admitted.length).toBe(65);
    expect(refused.length).toBe(30);
    // The set equality is the whole claim. A per-character loop over `refused`
    // asserting it is not in `allowed` was written and DELETED: `admitted` and
    // `refused` partition the 95 code points, so no mutant can fail that loop
    // while this line passes — the "same assertion twice" shape this file's cap
    // seam also had.
    expect(new Set(admitted)).toEqual(allowed);
  });

  // HOLDS AT BASE (a bound, not regression coverage): at base `step` was not a
  // coarse key, so every `step:` value was refused for a different reason. Marked
  // even though this test was ADDED to close a mutation hole — the round that added
  // it forgot this marker, which made the header's "grep HOLDS AT BASE for the
  // population" wrong on its first outing. A test being new is not the same claim
  // as a test being red at base.
  it('refuses NON-ASCII and DEL — the half the printable-ASCII sweep cannot see', () => {
    // 🔴 THE PRINTABLE-ASCII ENUMERATION STOPS AT 0x7E, so a class widened into a
    // non-Latin RANGE (Cyrillic, any CJK block) or by DEL survives it. The class
    // claims to exclude non-ASCII, and without these fixtures that claim is
    // sampled at exactly one code point.
    //
    // 🔴 EVERY INVISIBLE CHARACTER IS A `\u` ESCAPE, NEVER A PASTED LITERAL. A
    // zero-width space, a BOM, an NBSP and DEL are invisible in a diff and in most
    // greps, so a fixture spelled literally cannot be reviewed — and one of them
    // arrived in this file as a stray NUL byte the first time it was written,
    // which made the whole file read as binary to `grep`.
    for (const subtype of [
      'unicode-with-\u00fc',
      '\u0430\u0431\u0432', // Cyrillic
      '\u65e5\u672c\u8a9e', // CJK
      '\u00e9',
      '\u200b', // zero-width space
      '\ufeff', // BOM
      '\u007f', // DEL, one past the printable sweep's top
      'imageGen\u00a0', // NBSP, which is NOT the space the sweep covers
      'imageGen\u0000', // NUL
    ]) {
      expect(isBlockGenerationType(`step:${subtype}`)).toBe(false);
    }
  });

  it('admits every ORCHESTRATOR $type we measured — the class costs no fidelity', () => {
    // 🔴 THE CLOSEST THING TO A SEAM THIS AXIS CAN HAVE, and the honest limit is
    // stated rather than hidden: the character class's "no legitimate submit loses
    // its subtype" claim rests on an EXTERNAL measurement, so it can only be
    // pinned against a SNAPSHOT. This is the full 50-key
    // `WorkflowStepTemplate.discriminator.mapping` of
    // `https://orchestration.civitai.com/openapi/v2-consumers.json`, measured
    // 2026-09-17. It fails if the class is narrowed (that is its job); it CANNOT
    // see upstream adding a `$type` with an out-of-class character — the residual
    // the module header records as accepted and unguardable from in here.
    const LIVE_STEP_TYPES = [
      'aceStepAudio',
      'ageClassification',
      'audioCaptioning',
      'blobArchive',
      'chatCompletion',
      'comfy',
      'comfyNodepackSnapshot',
      'composeMedia',
      'convertImage',
      'customComfy',
      'echo',
      'imageBackgroundRemoval',
      'imageGen',
      'imageResourceTraining',
      'imageScanning',
      'imageToSvg',
      'imageUpload',
      'imageUpscaler',
      'mediaCaptioning',
      'mediaHash',
      'mediaRating',
      'miniMaxMusic3',
      'model3DPreview',
      'modelClamScan',
      'modelHash',
      'modelParseMetadata',
      'modelPickleScan',
      'polyGen',
      'preprocessImage',
      'preprocessVideo',
      'promptEnhancement',
      'qwenImageBench',
      'shieldstralModeration',
      'textToImage',
      'textToSpeech',
      'training',
      'transcode',
      'transcription',
      'videoBackgroundRemoval',
      'videoEnhancement',
      'videoFrameExtraction',
      'videoGen',
      'videoInterpolation',
      'videoMetadata',
      'videoUpscaler',
      'wdTagging',
      'webScrape',
      'webSearch',
      'xGuardModeration',
      'yuE2',
    ];
    // The count is asserted so a truncated fixture cannot pass as a full sweep.
    expect(LIVE_STEP_TYPES.length).toBe(50);
    expect(new Set(LIVE_STEP_TYPES).size).toBe(50);
    for (const $type of LIVE_STEP_TYPES) {
      expect(isBlockGenerationType(`step:${$type}`)).toBe(true);
      expect(resolveBlockGenerationType({ kind: 'step', $type, input: {}, maxBuzz: 1 })).toBe(
        `step:${$type}`
      );
    }
    // The longest key measured was 22 chars — well inside the 64 cap, which is
    // why the cap is not what this fixture is about.
    expect(Math.max(...LIVE_STEP_TYPES.map((t) => t.length))).toBeLessThan(
      BLOCK_PASS_THROUGH_SUBTYPE_MAX_CHARS
    );
  });

  // HOLDS AT BASE (a bound, not regression coverage): at base `step` was not a
  // coarse key, so every `step:` value was refused for a different reason.
  it('refuses a SECOND colon — the value stays a two-field record', () => {
    // Structural, not a separate check: `:` is not in the character class.
    expect(isBlockGenerationType('step:a:b')).toBe(false);
    expect(isBlockGenerationType('step:textToImage:txt2img')).toBe(false);
  });

  it('refuses an EMPTY subtype and enforces the length cap at the boundary', () => {
    expect(isBlockGenerationType('step:')).toBe(false);
    expect(isBlockGenerationType(`step:${'a'.repeat(64)}`)).toBe(true);
    expect(isBlockGenerationType(`step:${'a'.repeat(65)}`)).toBe(false);
  });

  // HOLDS AT BASE (a bound, not regression coverage): same reason — at base these
  // were refused by the unknown coarse key, not by the shape test.
  it('refuses whitespace, control characters and non-ASCII', () => {
    // 🔴 THE ANCHOR ASSERTIONS. An unanchored pattern would accept every one of
    // these (each CONTAINS a matching run), so these are what kill a mutant that
    // drops `^`/`$`.
    expect(isBlockGenerationType('step:foo bar')).toBe(false);
    expect(isBlockGenerationType('step:foo\nbar')).toBe(false);
    expect(isBlockGenerationType('step:imageGen\n')).toBe(false);
    expect(isBlockGenerationType('step:\timageGen')).toBe(false);
    expect(isBlockGenerationType(`step:${SP}imageGen`)).toBe(false);
    expect(isBlockGenerationType(`step:imageGen${SP}`)).toBe(false);
    expect(isBlockGenerationType('step:ünïcode')).toBe(false);
    expect(isBlockGenerationType('step:a/b')).toBe(false);
    expect(isBlockGenerationType('step:a\\b')).toBe(false);
  });

  it('the OPEN axis belongs to `step` ALONE — it does not leak to any other key', () => {
    // 🔴 THE MUTANT THIS EXISTS FOR: a rule lookup that returned the open
    // sentinel for the wrong key, or for the default, would wave an arbitrary
    // subtype through under EVERY coarse key. `imageGen` is shape-valid, so only
    // a fixture using a shape-valid-but-unregistered subtype can see that.
    expect(isBlockGenerationType('textToImage:imageGen')).toBe(false);
    expect(isBlockGenerationType('customComfy:imageGen')).toBe(false);
    expect(isBlockGenerationType('convert-image:imageGen')).toBe(false);
    expect(isBlockGenerationType('chat-completion:imageGen')).toBe(false);
    expect(isBlockGenerationType('videoToVideo:imageGen')).toBe(false);
    // …and conversely `step` does not inherit the closed keys' sets as its only
    // option: a value in NO closed set is still accepted under `step`.
    expect(isBlockGenerationType('step:notInAnyClosedSet')).toBe(true);
  });

  // HOLDS AT BASE (a bound, not regression coverage): at base no `step`-prefixed
  // value was accepted in any casing.
  it('is CASE-SENSITIVE on the coarse key and does not accept a near-miss key', () => {
    expect(isBlockGenerationType('Step:imageGen')).toBe(false);
    expect(isBlockGenerationType('STEP:imageGen')).toBe(false);
    expect(isBlockGenerationType('steps:imageGen')).toBe(false);
    expect(isBlockGenerationType('step ')).toBe(false);
  });

  it('composes and degrades through the ONE constructor', () => {
    expect(composeBlockGenerationType('step', 'imageGen')).toBe('step:imageGen');
    expect(composeBlockGenerationType('step', 'a:b')).toBe('step');
    expect(composeBlockGenerationType('step', '')).toBe('step');
    expect(composeBlockGenerationType('step', 'a'.repeat(65))).toBe('step');
    expect(composeBlockGenerationType('step', null)).toBe('step');
    // 🔴 `undefined`, NOT JUST `null`, AND THIS ONE WAS A REAL DEFECT. With a
    // `subtype !== null` guard the template interpolates the STRING "undefined",
    // which the shape test ACCEPTS — so the one constructor minted
    // `step:undefined` into a fee-bearing column. Harmless while every subtype
    // axis was closed (`textToImage:undefined` is in no set), i.e. the open axis
    // is what made it reachable. Off-type on purpose: the signature says
    // `string | null`, and the point is that a `as never` caller cannot mint it.
    expect(composeBlockGenerationType('step', undefined as never)).toBe('step');
    // The closed-arm half HOLDS AT BASE (a bound, not regression coverage):
    // `textToImage:undefined` was in no closed set, so it degraded there too. It
    // is kept so the fix is pinned for BOTH arms rather than only the open one.
    expect(composeBlockGenerationType('textToImage', undefined as never)).toBe('textToImage');
  });

  it('SEAM: the subtype cap equals the WIRE `$type` cap', () => {
    // 🔴 `generation-type.ts` carries its own literal copy of this number (it is
    // on the fire-and-forget spend path and must stay import-light). A wire cap
    // raised past that copy would silently degrade every long `$type` to a bare
    // `step` — a depth loss in a column that can never be backfilled, and
    // nothing else would report it.
    //
    // ONE equality, not the same equality written twice: `toBe` is symmetric, so
    // a reversed second assertion states nothing new. What makes this fail on
    // GROWTH and on SHRINKAGE alike is the equality plus the LITERAL below — the
    // literal is what stops the pair drifting together to a new value unnoticed.
    expect(BLOCK_PASS_THROUGH_SUBTYPE_MAX_CHARS).toBe(PASS_THROUGH_TYPE_MAX_CHARS);
    expect(BLOCK_PASS_THROUGH_SUBTYPE_MAX_CHARS).toBe(64);
  });

  it('SEAM: the coarse key IS the wire `kind` literal', () => {
    // 🔴 OTHERWISE NOTHING TIES THEM. Every unit fixture hand-builds `kind:'step'`
    // and never parses, so renaming the wire discriminator would leave this whole
    // suite green while the resolver's `kind === 'step'` branch stopped matching
    // any real body. Parsing with the constant is what joins the two.
    const parsed = blockPassThroughStepBodySchema.safeParse({
      kind: BLOCK_PASS_THROUGH_COARSE_TYPE,
      $type: 'imageGen',
      input: {},
      maxBuzz: 1,
    });
    expect(parsed.success).toBe(true);
    expect(BLOCK_PASS_THROUGH_COARSE_TYPE).toBe('step');
  });

  it('SEAM: the degrade path is REACHABLE FROM THE WIRE, not merely defensive', () => {
    // 🔴 MEASURED AGAINST THE REAL SCHEMA, because the whole "caller-influenced"
    // claim rests on it: `$type` is `z.string().min(1).max(64)` with NO character
    // class, so a body naming `a:b` — or a `$type` that would forge a value under
    // another fee group — PARSES, reaches the submit, and is bounded only here.
    // If this ever stops parsing, the shape bound becomes unreachable defence and
    // the tests above become invariant guards; that is worth knowing either way.
    // 🔴 THE RESOLVER IS RUN ON `parsed.data`, NOT ON A HAND-BUILT TWIN. The claim
    // is about what a PARSED body resolves to, and zod REBUILDS the object — a
    // hand-built literal would assert that claim about a different value that
    // merely looks the same.
    const parse = ($type: string) =>
      blockPassThroughStepBodySchema.safeParse({ kind: 'step', $type, input: {}, maxBuzz: 1 });

    // Wire-legal AND shape-refused: these are the ones the degrade path exists for.
    // `textToImage:txt2img` is the sharp one — it would forge a value under
    // another fee group if the subtype were taken raw.
    for (const hostile of ['a:b', 'textToImage:txt2img', 'foo bar', `imageGen${SP}`]) {
      const parsed = parse(hostile);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(resolveBlockGenerationType(parsed.data)).toBe('step');
    }

    // Wire-legal AND shape-accepted at the boundary: the same parse path keeps its
    // subtype, so the assertions above are about the SHAPE bound and not about the
    // parse merely failing.
    const atCap = 'a'.repeat(64);
    const parsedAtCap = parse(atCap);
    expect(parsedAtCap.success).toBe(true);
    if (parsedAtCap.success)
      expect(resolveBlockGenerationType(parsedAtCap.data)).toBe(`step:${atCap}`);

    // And one past the cap is refused by the WIRE, not by the shape bound — the
    // two bounds meet exactly here, which is what the cap SEAM test above pins.
    expect(parse('a'.repeat(65)).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unresolvable input
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveBlockGenerationType — unresolvable input degrades to NULL and never throws', () => {
  // The spend path is fire-and-forget and fail-open. Resolution must not become
  // a new way to throw on it, so every junk shape returns null rather than
  // raising. Each case is asserted to both NOT throw and to be null.
  const junk: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'textToImage'],
    ['a number', 42],
    ['an array', ['textToImage']],
    ['an empty object', {}],
    ['an unknown kind', { kind: 'videoToVideo', params: {} }],
    ['a non-string kind', { kind: 7 }],
    ['kind step with no step key', { kind: 'step', params: {} }],
    ['kind step with a non-string step', { kind: 'step', step: 7, params: {} }],
    ['kind step with a null step', { kind: 'step', step: null, params: {} }],
    ['an object with a null prototype', Object.create(null)],
  ];

  for (const [label, input] of junk) {
    it(`returns null for ${label}`, () => {
      expect(() => resolveBlockGenerationType(input)).not.toThrow();
      expect(resolveBlockGenerationType(input)).toBeNull();
    });
  }

  it('an unresolvable body stays NULL even when a valid image class is supplied', () => {
    // The context deepens a resolved value; it can never CREATE one. A junk body
    // with a perfectly good `imageWorkflowType` must not become
    // `textToImage:txt2img`.
    expect(
      resolveBlockGenerationType({ kind: 'videoToVideo' }, { imageWorkflowType: 'txt2img' })
    ).toBeNull();
    expect(resolveBlockGenerationType(null, { imageWorkflowType: 'txt2img' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BOUND — isBlockGenerationType as a SHAPE test
// ─────────────────────────────────────────────────────────────────────────────

describe('isBlockGenerationType bounds the open-ended value space', () => {
  it('accepts every coarse key and every composed value this build can produce', () => {
    // Literal expectations, one per shipped shape.
    expect(isBlockGenerationType('textToImage')).toBe(true);
    expect(isBlockGenerationType('textToImage:txt2img')).toBe(true);
    expect(isBlockGenerationType('textToImage:img2img')).toBe(true);
    expect(isBlockGenerationType('textToImage:img2img-edit')).toBe(true);
    expect(isBlockGenerationType('customComfy')).toBe(true);
    expect(isBlockGenerationType('customComfy:inline')).toBe(true);
    expect(isBlockGenerationType('customComfy:seamless-pano-360')).toBe(true);
    expect(isBlockGenerationType('customComfy:starter-comfy-txt2img')).toBe(true);
    expect(isBlockGenerationType('convert-image')).toBe(true);
    expect(isBlockGenerationType('chat-completion')).toBe(true);
  });

  it('rejects an UNKNOWN SUBTYPE under a known coarse key', () => {
    // 🔴 The half a membership test used to cover for free and a shape test has
    // to state. Without the per-coarse allowed-subtype set, a coarse-key check
    // alone would accept anything after the colon.
    expect(isBlockGenerationType('textToImage:not-a-class')).toBe(false);
    expect(isBlockGenerationType('textToImage:inline')).toBe(false); // the OTHER key's subtype
    expect(isBlockGenerationType('customComfy:not-a-recipe')).toBe(false);
    expect(isBlockGenerationType('customComfy:txt2img')).toBe(false); // the OTHER key's subtype
  });

  it('rejects a prototype key in EITHER position', () => {
    // Every lookup is an array membership test, never an index into a registry
    // object — in the coarse position and in the subtype position alike.
    expect(isBlockGenerationType('toString')).toBe(false);
    expect(isBlockGenerationType('constructor')).toBe(false);
    expect(isBlockGenerationType('__proto__')).toBe(false);
    expect(isBlockGenerationType('customComfy:toString')).toBe(false);
    expect(isBlockGenerationType('customComfy:constructor')).toBe(false);
    expect(isBlockGenerationType('customComfy:__proto__')).toBe(false);
    expect(isBlockGenerationType('textToImage:toString')).toBe(false);
    expect(isBlockGenerationType('toString:txt2img')).toBe(false);
  });

  it('rejects an UNKNOWN coarse key however plausible its subtype', () => {
    // 🔴 The subtypes here are deliberately REAL ones drawn from BOTH closed
    // sets, not invented tokens. The bound on the composite half is a single
    // membership test against "the set this coarse key allows", which for an
    // unknown key is the EMPTY set — so the only fixtures that can see a
    // fallback returning some OTHER key's set are ones whose subtype is in it.
    // Invented tokens would leave that mutant alive on a fully green suite.
    expect(isBlockGenerationType('videoToVideo:txt2img')).toBe(false);
    expect(isBlockGenerationType('videoToVideo:img2img-edit')).toBe(false);
    expect(isBlockGenerationType('videoToVideo:inline')).toBe(false);
    expect(isBlockGenerationType('videoToVideo:seamless-pano-360')).toBe(false);
    expect(isBlockGenerationType('convertImage:png')).toBe(false); // orchestrator spelling
    expect(isBlockGenerationType('texttoimage:txt2img')).toBe(false); // case-sensitive
    expect(isBlockGenerationType('texttoimage:img2img')).toBe(false);
  });

  it('rejects empty and degenerate spellings', () => {
    expect(isBlockGenerationType('')).toBe(false);
    expect(isBlockGenerationType(':')).toBe(false);
    expect(isBlockGenerationType(':txt2img')).toBe(false);
    expect(isBlockGenerationType('textToImage:')).toBe(false);
    expect(isBlockGenerationType('textToImage: txt2img')).toBe(false); // space is not trimmed
  });

  it('rejects non-strings', () => {
    expect(isBlockGenerationType(undefined)).toBe(false);
    expect(isBlockGenerationType(null)).toBe(false);
    expect(isBlockGenerationType(7)).toBe(false);
    expect(isBlockGenerationType(['textToImage'])).toBe(false);
    expect(isBlockGenerationType({ toString: () => 'textToImage' })).toBe(false);
  });
});

describe('composeBlockGenerationType degrades, never fabricates', () => {
  // The ONE place a value is constructed, and it validates its own output — so
  // the resolver cannot emit anything the write-side re-check would refuse.

  it('composes a valid pair', () => {
    expect(composeBlockGenerationType('textToImage', 'img2img-edit')).toBe(
      'textToImage:img2img-edit'
    );
    expect(composeBlockGenerationType('customComfy', 'inline')).toBe('customComfy:inline');
  });

  it('drops to the coarse key for an unusable subtype', () => {
    expect(composeBlockGenerationType('textToImage', 'nonsense')).toBe('textToImage');
    expect(composeBlockGenerationType('textToImage', '')).toBe('textToImage');
    expect(composeBlockGenerationType('customComfy', 'toString')).toBe('customComfy');
    expect(composeBlockGenerationType('customComfy', null)).toBe('customComfy');
  });

  it('drops to the coarse key for a COLON-BEARING subtype — the grammar holds', () => {
    // The at-most-one-colon rule is enforced STRUCTURALLY (every allowed subtype
    // is colon-free), not by a standalone check — a standalone check was written
    // and then deleted because a mutation sweep proved it unkillable. This pins
    // the BEHAVIOUR rather than the mechanism, so it stays meaningful whichever
    // way that is implemented. Note `img2img:edit` is the GRAPH's spelling: the
    // stored subtype is `img2img-edit`, so the raw graph value is correctly not
    // a legal subtype.
    expect(composeBlockGenerationType('customComfy', 'a:b')).toBe('customComfy');
    expect(composeBlockGenerationType('textToImage', 'img2img:edit')).toBe('textToImage');
  });

  it('returns NULL when the COARSE key itself is unknown — a subtype cannot rescue it', () => {
    expect(composeBlockGenerationType('videoToVideo', 'fast')).toBeNull();
    expect(composeBlockGenerationType('videoToVideo', null)).toBeNull();
    expect(composeBlockGenerationType('toString', null)).toBeNull();
  });

  it('never returns a value its own validator rejects', () => {
    // The seam, asserted rather than assumed. Every output of the producer is
    // accepted by the bound the consumer re-checks against.
    const pairs: [string, string | null][] = [
      ['textToImage', 'txt2img'],
      ['textToImage', 'img2img:edit'],
      ['textToImage', null],
      ['customComfy', 'seamless-pano-360'],
      ['customComfy', 'toString'],
      ['customComfy', null],
      ['convert-image', null],
      ['convert-image', 'png'],
      ['videoToVideo', 'fast'],
    ];
    for (const [coarse, subtype] of pairs) {
      const out = composeBlockGenerationType(coarse, subtype);
      if (out !== null) expect(isBlockGenerationType(out)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEDGERS — the sets stay derived, and fail when they GROW or SHRINK
// ─────────────────────────────────────────────────────────────────────────────

describe('the accepted sets stay DERIVED from the registries', () => {
  it('the image subtype set mirrors BLOCK_IMAGE_WORKFLOW_TYPES — in BOTH directions', () => {
    // 🔴 THE SEAM. `generation-type.ts` keeps the image workflow classes as a
    // LITERAL (it is on the fire-and-forget spend path and must stay
    // import-light, while `workflow.service` pulls in the generation-graph
    // pipeline). This is the only thing stopping the two drifting: a FOURTH
    // image workflow class added in workflow.service without a subtype spelling
    // here fails HERE, rather than silently recording the new class as a bare
    // `textToImage`. Fails on GROWTH and on SHRINKAGE alike.
    expect(BLOCK_IMAGE_WORKFLOW_TYPES.length).toBe(BLOCK_IMAGE_GENERATION_SUBTYPES.length);
    // Literal, so the translation is stated on both sides rather than computed.
    expect([...BLOCK_IMAGE_WORKFLOW_TYPES]).toEqual(['txt2img', 'img2img', 'img2img:edit']);
    expect([...BLOCK_IMAGE_GENERATION_SUBTYPES]).toEqual(['txt2img', 'img2img', 'img2img-edit']);
    // And each class really does resolve to a distinct, accepted value.
    const produced = BLOCK_IMAGE_WORKFLOW_TYPES.map((workflow) =>
      resolveBlockGenerationType({ kind: 'textToImage' }, { imageWorkflowType: workflow })
    );
    expect(new Set(produced).size).toBe(BLOCK_IMAGE_WORKFLOW_TYPES.length);
    for (const value of produced) expect(isBlockGenerationType(value)).toBe(true);
  });

  it('the customComfy subtype set is exactly every registered recipe plus "inline"', () => {
    expect([...CUSTOM_COMFY_GENERATION_SUBTYPES].sort()).toEqual(
      [...REGISTERED_RECIPE_IDS, 'inline'].sort()
    );
  });

  it('every registered recipe id resolves through the recipe arm', () => {
    for (const id of REGISTERED_RECIPE_IDS) {
      expect(resolveBlockGenerationType({ kind: 'customComfy', recipe: id, params: {} })).toBe(
        `customComfy:${id}`
      );
    }
  });

  it('every registered step id resolves through the kind:step path', () => {
    for (const id of REGISTERED_STEP_IDS) {
      expect(resolveBlockGenerationType({ kind: 'step', step: id, params: {} })).toBe(id);
    }
  });

  it('BLOCK_GENERATION_TYPES and isBlockGenerationType agree over the CLOSED population', () => {
    // The ledger is not the bound (the shape test is) — this is what keeps them
    // from diverging. Fails if the ledger GROWS past what the bound accepts, or
    // SHRINKS below what the resolver can emit ON THE CLOSED ARMS.
    expect([...BLOCK_GENERATION_TYPES].sort()).toEqual(
      [
        'textToImage',
        'textToImage:txt2img',
        'textToImage:img2img',
        'textToImage:img2img-edit',
        'customComfy',
        'customComfy:inline',
        ...REGISTERED_RECIPE_IDS.map((id) => `customComfy:${id}`),
        ...REGISTERED_STEP_IDS,
        // The pass-through COARSE key. Its `step:<$type>` values are NOT here —
        // see the next test, which pins that exclusion as a decision.
        'step',
      ].sort()
    );
    for (const value of BLOCK_GENERATION_TYPES) {
      expect(isBlockGenerationType(value)).toBe(true);
    }
    // Every coarse key is itself a legal stored value (the degraded form).
    for (const coarse of BLOCK_GENERATION_COARSE_TYPES) {
      expect(isBlockGenerationType(coarse)).toBe(true);
    }
  });

  it('the LEDGER deliberately EXCLUDES the open `step:` arm — asserted, not merely absent', () => {
    // 🔴 THE HONEST HALF OF THE WIDENING. `BLOCK_GENERATION_TYPES` is an
    // enumeration, and the pass-through subtype is a caller-supplied `$type`
    // bounded by SHAPE — an infinite set with no finite enumeration. So the
    // ledger's bidirectional claim ("it covers everything the resolver can
    // emit") is FALSE for this one arm, and the choice is either to weaken that
    // test into vacuity or to state the exemption and pin it. This is the second.
    //
    // Three assertions, together stating exactly what the gap is:
    //   1. no ledger member is a `step:` value — nobody has "fixed" the gap by
    //      sampling one, which would read as complete coverage of an open set;
    expect(BLOCK_GENERATION_TYPES.filter((v) => v.startsWith('step:'))).toEqual([]);
    //   2. the bare coarse key IS in the ledger, so the arm is represented at the
    //      depth at which it is finite — which is the depth the fee keys on;
    expect(BLOCK_GENERATION_TYPES as readonly string[]).toContain('step');
    //   3. the resolver really does emit values the bound accepts and the ledger
    //      does not contain. Without this the exclusion could be satisfied by a
    //      resolver that never produced a `step:` value at all — i.e. by the bug
    //      this change fixes.
    const emitted = resolveBlockGenerationType({
      kind: 'step',
      $type: 'imageBackgroundRemoval',
      input: {},
      maxBuzz: 1,
    });
    expect(emitted).toBe('step:imageBackgroundRemoval');
    expect(isBlockGenerationType(emitted)).toBe(true);
    expect(BLOCK_GENERATION_TYPES as readonly string[]).not.toContain(emitted);
  });

  it('INVARIANT GUARD, plus one assertion that is NOT: no registered step id collides with a kind key', () => {
    // The LOOP is the invariant guard: nothing has ever violated it and it passed
    // before this change too. It exists because the ONE-COLUMN design rests on it —
    // a step id implies `kind: 'step'` only while the two name spaces stay
    // disjoint, and the registry's own load-time invariants do not know these
    // strings exist. A step registered as `textToImage` would make the column
    // ambiguous; this turns that into a red test rather than a silent ambiguity.
    //
    // 🔴 IT NOW COVERS `step` TOO, and that is why `BLOCK_PASS_THROUGH_COARSE_TYPE`
    // is a member of the tuple this loops over rather than a constant beside it.
    // A step registered as `step` would make a bare `step` value mean EITHER "a
    // pass-through submit whose `$type` was unusable" OR "the registered step
    // named `step`" — the ambiguity this design's one-column reading forbids.
    //
    // ⚠️ AND THAT MAKES THE NEXT LINE REGRESSION COVERAGE, NOT AN INVARIANT GUARD,
    // which the title used to deny. It is RED at base, where the tuple held only
    // `textToImage` and `customComfy`. Separated because the two halves have
    // different standing: the loop would pass on either tree, this one would not.
    expect(BLOCK_WORKFLOW_KIND_GENERATION_TYPES as readonly string[]).toContain('step');
    for (const id of REGISTERED_STEP_IDS) {
      expect(BLOCK_WORKFLOW_KIND_GENERATION_TYPES as readonly string[]).not.toContain(id);
    }
  });

  it('INVARIANT GUARD (not regression coverage): no registry id contains a colon', () => {
    // Also never violated, and also load-bearing: a registry id is interpolated
    // verbatim into the subtype, so a colon in one would make the value carry
    // two. `composeBlockGenerationType` refuses such a value at runtime (it
    // degrades to the coarse key and loses the sub-axis), and this guard is what
    // makes that a visible decision at registration time rather than a silent
    // loss in the column.
    for (const id of [...REGISTERED_RECIPE_IDS, ...REGISTERED_STEP_IDS]) {
      expect(id).not.toContain(':');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-MODULE SEAM — the FEE is the consumer this namespace exists to protect
// ─────────────────────────────────────────────────────────────────────────────

describe('the author fee groups a pass-through row under `step`, never under a kind key', () => {
  // 🔴 THIS IS THE ONLY TEST HERE THAT EXERCISES THE ACTUAL CONSUMER, and it was
  // added when the fee landed on `main` mid-review. Everything else in this file
  // pins the VALUE; this pins what the fee DOES with it. `author-fee.ts`'s
  // resolver bounds its key with `isBlockGenerationType`, tries the FULL value,
  // then falls back to `blockGenerationCoarseType` — so "the namespace keeps a
  // caller out of another fee group" is a claim about THAT function, and is
  // otherwise asserted nowhere.
  //
  // ⚠️ SCOPED HONESTLY: the fee is DARK (slice 1 moves no money) and the platform
  // table has ONE entry, so today both a namespaced and a bare value would land on
  // the default. The exposure becomes live the moment any table carries a kind-key
  // or a fee-free entry — which slice 3 makes per-app and author-editable. These
  // fixtures therefore use a config WITH such entries rather than only the
  // platform one: a test over the single-entry table could not see the hazard.

  /** A config shaped like one slice 3 would let an author write. */
  const authorConfig: BlockAuthorFeeConfig = {
    default: { flatBuzz: 7, pctOfBase: 0.07 },
    byType: [
      ['textToImage', { flatBuzz: 1, pctOfBase: 0.01 }],
      ['chat-completion', { flatBuzz: 0, pctOfBase: 0 }],
      ['step', { flatBuzz: 5, pctOfBase: 0.05 }],
    ],
  };

  it("a pass-through $type equal to a KIND KEY does not inherit that key's fee", () => {
    const passThrough = resolveBlockAuthorFeeParams(authorConfig, 'step:textToImage');
    expect(passThrough.coarseType).toBe('step');
    expect(passThrough.source).toBe('coarse');
    expect(passThrough.params).toEqual({ flatBuzz: 5, pctOfBase: 0.05 });
    // And the genuine image submit still gets ITS entry — so the two are
    // distinguishable, which is the whole point.
    const genuine = resolveBlockAuthorFeeParams(authorConfig, 'textToImage');
    expect(genuine.coarseType).toBe('textToImage');
    expect(genuine.params).toEqual({ flatBuzz: 1, pctOfBase: 0.01 });
    expect(passThrough.params).not.toEqual(genuine.params);
  });

  it('a pass-through $type equal to a FEE-FREE registry id does not inherit the zero fee', () => {
    // The sharper direction: an app naming a `$type` that collides with a
    // zero-fee entry would pay NOTHING if the value were recorded bare.
    const passThrough = resolveBlockAuthorFeeParams(authorConfig, 'step:chat-completion');
    expect(passThrough.coarseType).toBe('step');
    expect(passThrough.params).toEqual({ flatBuzz: 5, pctOfBase: 0.05 });
    expect(resolveBlockAuthorFeeParams(authorConfig, 'chat-completion').params).toEqual({
      flatBuzz: 0,
      pctOfBase: 0,
    });
  });

  it('under the PLATFORM config a pass-through row falls to the default, and is labelled `step`', () => {
    // The state as shipped: one `chat-completion` entry, so the params are the
    // default — but the coarse LABEL is already `step`, which is what the fee's
    // counters carry and what makes the population visible before any money moves.
    const resolved = resolveBlockAuthorFeeParams(
      BLOCK_AUTHOR_FEE_PLATFORM_CONFIG,
      'step:imageBackgroundRemoval'
    );
    expect(resolved.source).toBe('default');
    expect(resolved.coarseType).toBe('step');
    // A bare `step` (a shape-refused `$type`) groups identically — the degrade
    // costs depth, never the group.
    expect(resolveBlockAuthorFeeParams(BLOCK_AUTHOR_FEE_PLATFORM_CONFIG, 'step').coarseType).toBe(
      'step'
    );
  });

  it('an out-of-shape `step:` value is refused by the fee resolver too, not grouped', () => {
    // The fee bounds its key with `isBlockGenerationType`, so a value this module
    // would refuse gets `coarseType: null` there rather than a guessed group.
    for (const hostile of ['step:a:b', `step:${'a'.repeat(65)}`, 'step:foo bar']) {
      const resolved = resolveBlockAuthorFeeParams(authorConfig, hostile);
      expect(resolved.coarseType).toBeNull();
      expect(resolved.source).toBe('default');
    }
  });
});
