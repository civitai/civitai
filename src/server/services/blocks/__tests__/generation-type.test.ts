import { describe, expect, it } from 'vitest';

import {
  BLOCK_GENERATION_COARSE_TYPES,
  BLOCK_GENERATION_TYPES,
  BLOCK_IMAGE_GENERATION_SUBTYPES,
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
 * NOTE ON WHAT THESE ARE. Two populations, deliberately labelled apart:
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
 *   - Two tests are explicitly labelled INVARIANT GUARD. Nothing has ever
 *     violated them; they would pass on either tree.
 *
 * Expected values are pinned as LITERALS throughout — never re-derived from the
 * function under test, and never from the registry entry the assertion is about.
 */

// ─────────────────────────────────────────────────────────────────────────────
// THE VALUE GRAMMAR
// ─────────────────────────────────────────────────────────────────────────────

describe('the value grammar — <coarse>:<subtype>, coarse before the FIRST colon', () => {
  // 🔴 THE LOAD-BEARING RULE OF THE WHOLE WIDENING. A separate (unbuilt)
  // per-generation-type author fee keys on the COARSE key and must keep working
  // unchanged as the subtype axis grows. If these go red, that feature silently
  // stops finding its rate.

  it('the coarse key is exactly the four that existed before the subtype axis', () => {
    // Literal, not derived. Widening this set is a wire-contract decision and a
    // fee-table decision; it must not happen by accident.
    expect([...BLOCK_GENERATION_COARSE_TYPES].sort()).toEqual(
      ['chat-completion', 'convert-image', 'customComfy', 'textToImage'].sort()
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

  it('BLOCK_GENERATION_TYPES and isBlockGenerationType agree over the whole population', () => {
    // The ledger is not the bound (the shape test is) — this is what keeps them
    // from diverging. Fails if the ledger GROWS past what the bound accepts, or
    // SHRINKS below what the resolver can emit.
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

  it('INVARIANT GUARD (not regression coverage): no registered step id collides with a kind key', () => {
    // Labelled as an invariant guard because nothing has ever violated it — it
    // would have passed before this change too. It exists because the ONE-COLUMN
    // design rests on it: a step id implies `kind: 'step'` only while the two
    // name spaces stay disjoint, and the registry's own load-time invariants do
    // not know these two strings exist. A step registered as `textToImage` would
    // make the column ambiguous; this turns that into a red test rather than a
    // silently ambiguous column.
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
