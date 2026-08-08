import { describe, expect, it } from 'vitest';
import {
  blockCustomComfyBodySchema,
  blockInlineComfyBodySchema,
  blockWorkflowBodySchema,
  INLINE_GRAPH_NODES_MAX,
  INLINE_MAX_BUZZ,
  INLINE_RESOURCES_MAX,
} from '~/server/schema/blocks/workflow.schema';
import { DEV_BUZZ_BUDGET_CAP } from '~/server/services/blocks/dev-scoped-mint.service';
import { REGISTERED_RECIPE_IDS } from '~/server/services/blocks/recipes';
import { REGISTERED_STEP_IDS } from '~/server/services/blocks/steps';

/**
 * Wire-contract coverage for the customComfy INLINE arm (`mode:'inline'`).
 *
 * Two things are expensive to get wrong here and both have tests that go red:
 *
 *   1. **BACK-COMPAT.** The arm was added to a union that every deployed app and
 *      every published `@civitai/app-sdk` body parses through. The first block
 *      below is the regression guard: it pins that a recipe / textToImage / step
 *      body still parses. That is not ceremony — the obvious zod spelling for
 *      this change (nesting a `discriminatedUnion('mode', …)`) CONSTRUCTS fine
 *      and then rejects every existing recipe body, because zod does not read a
 *      discriminator value through a `.default()`. These tests are what catches
 *      that.
 *   2. **`.strict()` IS A SECURITY GATE, NOT HYGIENE.** `CustomComfyInput` carries
 *      `sessionOwnerApiToken` (a Civitai API token forwarded to the claiming
 *      worker), `comfyImage` (an arbitrary OCI container), `minVramGb` (changes
 *      the worker tier and so the Buzz/second rate the ceiling argument rests
 *      on), and three more. The step input is built server-side from an
 *      allowlist, and `.strict()` is the second belt.
 */

const RECIPE_ID = REGISTERED_RECIPE_IDS[0];
const STEP_ID = REGISTERED_STEP_IDS[0];

function inlineBody(over: Record<string, unknown> = {}) {
  return {
    kind: 'customComfy',
    mode: 'inline',
    workflow: {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['1', 1] } },
    },
    resources: [],
    maxBuzz: 60,
    ...over,
  };
}

describe('blockWorkflowBodySchema — the pre-existing members still parse (back-compat)', () => {
  it('a RECIPE customComfy body (no `mode` key) parses, unchanged', () => {
    const parsed = blockWorkflowBodySchema.safeParse({
      kind: 'customComfy',
      recipe: RECIPE_ID,
      params: { prompt: 'a sunset', engine: 'zimage-turbo' },
    });
    expect(parsed.success).toBe(true);
    // 🔴 toStrictEqual, NOT toEqual. The recipe arm's `mode` is an OPTIONAL
    // literal, and `toEqual` treats `{…, mode: undefined}` as equal to `{…}` —
    // so it would not notice a `mode` key materialising in the parsed output.
    // That output is the object the router and the settle record consume, and
    // `@civitai/app-sdk` mirrors this shape, so "byte-identical" has to be
    // asserted strictly or it is not being asserted.
    expect(parsed.success && parsed.data).toStrictEqual({
      kind: 'customComfy',
      recipe: RECIPE_ID,
      params: { prompt: 'a sunset', engine: 'zimage-turbo' },
    });
  });

  it('an EXPLICIT `mode: "recipe"` is also accepted (the arm is opt-in, not forbidden)', () => {
    const parsed = blockWorkflowBodySchema.safeParse({
      kind: 'customComfy',
      mode: 'recipe',
      recipe: RECIPE_ID,
      params: {},
    });
    expect(parsed.success).toBe(true);
  });

  it('a rejected body still reports the PRECISE field path, not a bare union error', () => {
    // The union construction is easy to get subtly wrong in a way that keeps
    // rejection working but collapses every error to `path: []`. That path is
    // the only diagnostic an app author gets for a bounced submit.
    const parsed = blockWorkflowBodySchema.safeParse({
      kind: 'customComfy',
      recipe: 'not-a-recipe',
      params: {},
    });
    expect(parsed.success).toBe(false);
    expect(
      parsed.success === false && parsed.error.issues.some((i) => i.path.includes('recipe'))
    ).toBe(true);
  });

  it('a textToImage body parses, unchanged', () => {
    // Same fixture as workflow.schema.step.test.ts, which pins the SAME property
    // for the previous union member.
    const body = {
      kind: 'textToImage' as const,
      modelId: 123,
      modelVersionId: 456,
      params: { prompt: 'a cat', quantity: 1 },
    };
    const parsed = blockWorkflowBodySchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(body);
  });

  it('a step body parses, unchanged', () => {
    const parsed = blockWorkflowBodySchema.safeParse({
      kind: 'step',
      step: STEP_ID,
      params: {},
    });
    expect(parsed.success).toBe(true);
  });

  it('an UNREGISTERED recipe id still fails closed', () => {
    expect(
      blockWorkflowBodySchema.safeParse({
        kind: 'customComfy',
        recipe: 'not-a-recipe',
        params: {},
      }).success
    ).toBe(false);
  });

  it('an unknown `kind` is still rejected', () => {
    expect(blockWorkflowBodySchema.safeParse({ kind: 'chatCompletion', model: 'x' }).success).toBe(
      false
    );
  });
});

describe('blockWorkflowBodySchema — the INLINE arm', () => {
  it('accepts an inline body carrying a graph', () => {
    const parsed = blockWorkflowBodySchema.safeParse(inlineBody());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({
      kind: 'customComfy',
      mode: 'inline',
      maxBuzz: 60,
      // Defaults applied so the router never reads undefined.
      prompt: '',
      negativePrompt: '',
    });
  });

  it('the two arms are MUTUALLY EXCLUSIVE — a body naming both is rejected', () => {
    expect(
      blockWorkflowBodySchema.safeParse(inlineBody({ recipe: RECIPE_ID, params: {} })).success
    ).toBe(false);
    // …and a recipe body that also carries `mode` is likewise rejected: neither
    // arm accepts it, so there is no ambiguity for the union to resolve.
    expect(
      blockWorkflowBodySchema.safeParse({
        kind: 'customComfy',
        recipe: RECIPE_ID,
        params: {},
        mode: 'inline',
      }).success
    ).toBe(false);
  });

  it('a node must carry class_type + inputs', () => {
    expect(
      blockWorkflowBodySchema.safeParse(inlineBody({ workflow: { '1': { class_type: 'X' } } }))
        .success
    ).toBe(false);
    expect(
      blockWorkflowBodySchema.safeParse(inlineBody({ workflow: { '1': { inputs: {} } } })).success
    ).toBe(false);
    // A node with an EXTRA key is rejected too — the node schema is `.strict()`.
    expect(
      blockWorkflowBodySchema.safeParse(
        inlineBody({ workflow: { '1': { class_type: 'X', inputs: {}, _meta: {} } } })
      ).success
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE NEVER-APP-SETTABLE FIELDS. Each of these is a real capability on
// `CustomComfyInput`; an app that could set one would get, respectively: a
// Civitai API token belonging to the session owner, an arbitrary container to
// run, a different worker tier (and therefore a different Buzz/second rate than
// the ceiling assumes), worker session affinity, an attention-kernel flag, and a
// submit-time affordability gate. The router never spreads the body into the
// step input; this asserts the wire also refuses to carry them.
// ─────────────────────────────────────────────────────────────────────────────
describe('blockWorkflowBodySchema — inline arm rejects every CustomComfyInput field an app must not set', () => {
  const forbidden: Array<[string, unknown]> = [
    ['sessionOwnerApiToken', 'civitai-api-token'],
    ['comfyImage', 'urn:air:oci:image:ghcr:evil/comfy@v1'],
    ['minVramGb', 48],
    ['sessionId', 'sess_1'],
    ['useSageAttention', true],
    ['minimumDurationSeconds', 300],
    ['trace', 'binary'],
  ];

  it.each(forbidden)('rejects an inline body setting `%s`', (field, value) => {
    const parsed = blockWorkflowBodySchema.safeParse(inlineBody({ [field as string]: value }));
    expect(parsed.success).toBe(false);
  });

  it('POSITIVE CONTROL — the same body WITHOUT the extra field parses', () => {
    // Without this, every assertion above could be passing because the fixture
    // is malformed for some unrelated reason.
    expect(blockWorkflowBodySchema.safeParse(inlineBody()).success).toBe(true);
  });
});

describe('blockWorkflowBodySchema — inline arm bounds', () => {
  it('maxBuzz is required and bounded to INLINE_MAX_BUZZ', () => {
    expect(blockWorkflowBodySchema.safeParse(inlineBody({ maxBuzz: undefined })).success).toBe(
      false
    );
    expect(blockWorkflowBodySchema.safeParse(inlineBody({ maxBuzz: 0 })).success).toBe(false);
    expect(blockWorkflowBodySchema.safeParse(inlineBody({ maxBuzz: -1 })).success).toBe(false);
    expect(blockWorkflowBodySchema.safeParse(inlineBody({ maxBuzz: 1.5 })).success).toBe(false);
    expect(
      blockWorkflowBodySchema.safeParse(inlineBody({ maxBuzz: INLINE_MAX_BUZZ })).success
    ).toBe(true);
    expect(
      blockWorkflowBodySchema.safeParse(inlineBody({ maxBuzz: INLINE_MAX_BUZZ + 1 })).success
    ).toBe(false);
  });

  it('🔴 INLINE_MAX_BUZZ is DERIVED from DEV_BUZZ_BUDGET_CAP, not invented', () => {
    // The constant is spelled as a literal in the schema so the wire layer stays
    // import-light. This is what stops the derivation drifting silently: if
    // someone changes the dev per-call cap, this goes red and the reason for
    // the inline ceiling has to be re-stated rather than quietly diverging.
    expect(INLINE_MAX_BUZZ).toBe(DEV_BUZZ_BUDGET_CAP);
  });

  it('an empty graph is rejected', () => {
    expect(blockWorkflowBodySchema.safeParse(inlineBody({ workflow: {} })).success).toBe(false);
  });

  it('the node count is bounded', () => {
    const node = { class_type: 'X', inputs: {} };
    const atCap = Object.fromEntries(
      Array.from({ length: INLINE_GRAPH_NODES_MAX }, (_, i) => [String(i), node])
    );
    const overCap = Object.fromEntries(
      Array.from({ length: INLINE_GRAPH_NODES_MAX + 1 }, (_, i) => [String(i), node])
    );
    expect(blockWorkflowBodySchema.safeParse(inlineBody({ workflow: atCap })).success).toBe(true);
    expect(blockWorkflowBodySchema.safeParse(inlineBody({ workflow: overCap })).success).toBe(
      false
    );
  });

  it('the serialized graph size is bounded (payload DoS + audit-sweep bound)', () => {
    const huge = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a'.repeat(300_000) } },
    };
    expect(blockWorkflowBodySchema.safeParse(inlineBody({ workflow: huge })).success).toBe(false);
  });

  it('the declared resource fan-out is bounded', () => {
    const air = (n: number) => `urn:air:sdxl:lora:civitai:1@${n}`;
    const atCap = Array.from({ length: INLINE_RESOURCES_MAX }, (_, i) => air(i));
    expect(blockWorkflowBodySchema.safeParse(inlineBody({ resources: atCap })).success).toBe(true);
    expect(
      blockWorkflowBodySchema.safeParse(inlineBody({ resources: [...atCap, air(999)] })).success
    ).toBe(false);
  });

  it('prompt / negativePrompt are length-bounded', () => {
    expect(
      blockWorkflowBodySchema.safeParse(inlineBody({ prompt: 'a'.repeat(1501) })).success
    ).toBe(false);
    expect(
      blockWorkflowBodySchema.safeParse(inlineBody({ negativePrompt: 'a'.repeat(1501) })).success
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE ACCEPT/REJECT BOUNDARY, PINNED AS A TABLE.
//
// The arms now carry a custom `error` map so a rejected `customComfy` body is
// told which arm it landed on and what the other one is (see the ARM-AWARE
// REJECTION MESSAGES block in `workflow.schema.ts`; the message text itself is
// asserted at the router seam in `blocks.router.workflow.test.ts`).
//
// A custom error map is not supposed to move the boundary — but "not supposed
// to" is a claim, and the whole reason `.strict()` is here is that on this arm
// it is a security gate rather than hygiene. So the VERDICT is pinned
// independently of the text: every row below is a boolean that must not move,
// whatever a message says. This is an INVARIANT GUARD, deliberately labelled as
// one — it was green before the message change and must stay green after.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 blockWorkflowBodySchema — customComfy accept/reject boundary is unchanged', () => {
  const RECIPE_BODY = { kind: 'customComfy', recipe: RECIPE_ID, params: { prompt: 'x' } };

  const cases: Array<[string, unknown, boolean]> = [
    ['recipe body, no `mode` (every deployed app)', RECIPE_BODY, true],
    ['recipe body, explicit `mode:"recipe"`', { ...RECIPE_BODY, mode: 'recipe' }, true],
    ['recipe body + an unknown key', { ...RECIPE_BODY, graph: {} }, false],
    ['recipe body + an unregistered recipe id', { ...RECIPE_BODY, recipe: 'nope' }, false],
    ['inline body', inlineBody(), true],
    ['inline body + an unknown key', inlineBody({ graph: {} }), false],
    ['inline body, maxBuzz over the ceiling', inlineBody({ maxBuzz: INLINE_MAX_BUZZ + 1 }), false],
    ['inline body, maxBuzz at the ceiling', inlineBody({ maxBuzz: INLINE_MAX_BUZZ }), true],
    ['inline body missing maxBuzz', inlineBody({ maxBuzz: undefined }), false],
    ['a body naming BOTH arms', inlineBody({ recipe: RECIPE_ID, params: {} }), false],
    ['an unknown `mode` value', { ...RECIPE_BODY, mode: 'graph' }, false],
    ['`mode:"inline"` on a recipe-shaped body', { ...RECIPE_BODY, mode: 'inline' }, false],
    ['a bare string where a body is expected', 'customComfy', false],
    ['a null body', null, false],
  ];

  it.each(cases)('%s → %s', (_label, body, accepted) => {
    expect(blockWorkflowBodySchema.safeParse(body).success).toBe(accepted);
  });

  // The seven `CustomComfyInput` fields an app must never set are pinned as
  // REJECTED in their own table above (`inline arm rejects every
  // CustomComfyInput field an app must not set`) — the error map cannot have
  // moved them, because it never runs before the verdict is decided. This asserts
  // the same for the RECIPE arm, which had no such table.
  it.each([
    'sessionOwnerApiToken',
    'comfyImage',
    'minVramGb',
    'sessionId',
    'useSageAttention',
    'minimumDurationSeconds',
    'trace',
  ])('the RECIPE arm also rejects `%s`', (field) => {
    expect(blockWorkflowBodySchema.safeParse({ ...RECIPE_BODY, [field]: 'x' }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE ARM ERROR MAP'S EARLY RETURN, MADE REACHABLE.
//
// `customComfyArmErrorMap` opens with `if (iss.code !== 'unrecognized_keys')
// return undefined;` so zod keeps its own message for every other issue. That
// line is asserted at the router seam only INDIRECTLY (a bad `maxBuzz` keeps its
// `Too big:` message) — and that assertion cannot fail, because a per-FIELD
// issue is raised by the field's schema and never consults the object's error
// map at all. Deleting the line was MEASURED to leave every other test in both
// this file and `blocks.router.workflow.test.ts` green.
//
// The one issue an OBJECT schema raises itself, other than `unrecognized_keys`,
// is `invalid_type` for a non-object input — and the outer `kind` discriminated
// union rejects a non-object before any arm sees it, so that code is
// unreachable through `blockWorkflowBodySchema` and therefore through the
// router. Parsing the exported arm directly is the only way to reach it. With
// the early return deleted, these two report the arm blurb with an EMPTY key
// list ("recipe body:  — a `customComfy` body has two forms…") instead of
// zod's `Invalid input: expected object, received string`.
//
// Whole-string, for the same reason as the router-seam assertions: a blurb
// leaking into this message would still `toContain` every word you would think
// to check for.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 the arm error map returns UNDEFINED for every non-`unrecognized_keys` issue', () => {
  it.each([
    ['recipe', blockCustomComfyBodySchema],
    ['inline', blockInlineComfyBodySchema],
  ])("the %s arm keeps zod's own `invalid_type` message for a non-object body", (_arm, schema) => {
    const parsed = schema.safeParse('customComfy');
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toHaveLength(1);
    expect(parsed.error.issues[0].code).toBe('invalid_type');
    expect(parsed.error.issues[0].message).toBe('Invalid input: expected object, received string');
  });
});
