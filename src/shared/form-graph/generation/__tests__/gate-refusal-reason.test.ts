import { describe, expect, it } from 'vitest';
import { generationHub, workflowOutput } from '~/shared/form-graph/generation/hub.graph';
import { reconcileSelectors } from '~/shared/form-graph/generation/reconcile';
import type { GenerationCtx } from '~/shared/generation/context';
import { ecosystemFieldSchemas } from '~/shared/form-graph/generation/shared';
import { applicableRulesFor, rulesToStates, type GateRule } from '~/shared/generation/gates';

/**
 * A gated ecosystem/workflow is refused by its node's OUTPUT schema, and that
 * refusal is all an API caller (an App Blocks app) ever sees.
 *
 * The refusal must:
 *   - START with the stable text, since callers match on it;
 *   - append a SHOWN (disabled / members-only) rule's message;
 *   - never carry a HIDDEN rule's message.
 * `validateInput` turns these into `Validation failed: <field>: <message>`;
 * `orchestration-new.substitution-replies.test.ts` pins that end to end.
 */

// Literal on purpose: API callers match on this exact text, so the test pins
// the contract rather than whatever constant the implementation exports.
const ECOSYSTEM_UNAVAILABLE = 'Ecosystem is currently unavailable';
const WORKFLOW_UNAVAILABLE = 'Workflow is currently unavailable';
const USER_COPY = 'Back after maintenance.';
const SECRET = 'internal-note-must-not-leak';

const ext = (gateRules: GenerationCtx['gateRules']): GenerationCtx => ({
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: false, tier: 'free' },
  flags: {},
  gateRules,
});

const rule = (overrides: Partial<GateRule>): GateRule => ({
  id: 'rule-1',
  name: 'test',
  availableTo: 'nobody',
  presentation: 'disabled',
  message: USER_COPY,
  ecosystems: [],
  workflows: [],
  modelVersionIds: [],
  ...overrides,
});

const parse = (ctx: GenerationCtx, input: Record<string, unknown> = {}) =>
  generationHub.parse(
    reconcileSelectors({
      workflow: 'txt2img',
      ecosystem: 'SDXL',
      prompt: 'a cat',
      quantity: 1,
      ...input,
    }).raw,
    ctx
  ) as { success: boolean; errors?: Record<string, { message: string }>; data?: unknown };

const errorOf = (result: ReturnType<typeof parse>, key: string) =>
  result.success ? undefined : result.errors?.[key]?.message;

describe('gate refusals carry a shown rule’s message', () => {
  // Control: the same request with no rule is not refused on either field, so
  // the assertions below are about the rule, not an unrelated failure.
  it('CONTROL: no rule, no ecosystem/workflow refusal', () => {
    const result = parse(ext([]));
    expect(errorOf(result, 'ecosystem')).toBeUndefined();
    expect(errorOf(result, 'workflow')).toBeUndefined();
  });

  it('disabled ecosystem: stable text, then the rule message', () => {
    const result = parse(ext([rule({ ecosystems: ['SDXL'] })]));
    expect(errorOf(result, 'ecosystem')).toBe(`${ECOSYSTEM_UNAVAILABLE}. ${USER_COPY}`);
  });

  it('members-only ecosystem (non-member): stable text, then the rule message', () => {
    const result = parse(ext([rule({ availableTo: 'members', ecosystems: ['SDXL'] })]));
    expect(errorOf(result, 'ecosystem')).toBe(`${ECOSYSTEM_UNAVAILABLE}. ${USER_COPY}`);
  });

  // A moderators-only rule gates ordinary users, so it stays applicable to them and keeps its message.
  it('a moderators-only rule reaches an ordinary user with its message', () => {
    const stored = [rule({ availableTo: 'moderators', ecosystems: ['SDXL'] })];
    const forUser = applicableRulesFor(stored, {
      isModerator: false,
      isMember: false,
      hasTestingAccess: false,
    });
    expect(errorOf(parse(ext(forUser)), 'ecosystem')).toBe(
      `${ECOSYSTEM_UNAVAILABLE}. ${USER_COPY}`
    );
    // ...and a moderator is not gated at all.
    const forMod = applicableRulesFor(stored, {
      isModerator: true,
      isMember: false,
      hasTestingAccess: true,
    });
    expect(errorOf(parse(ext(forMod)), 'ecosystem')).toBeUndefined();
  });

  it('a disabled rule with no message keeps the bare stable text', () => {
    const result = parse(ext([rule({ message: null, ecosystems: ['SDXL'] })]));
    expect(errorOf(result, 'ecosystem')).toBe(ECOSYSTEM_UNAVAILABLE);
  });

  it('disabled workflow: stable text, then the rule message', () => {
    const result = parse(ext([rule({ workflows: ['txt2img'] })]));
    expect(errorOf(result, 'workflow')).toBe(`${WORKFLOW_UNAVAILABLE}. ${USER_COPY}`);
  });

  it('hidden workflow: bare stable text, no message', () => {
    const result = parse(
      ext([rule({ presentation: 'hidden', message: SECRET, workflows: ['txt2img'] })])
    );
    expect(errorOf(result, 'workflow')).toBe(WORKFLOW_UNAVAILABLE);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

/**
 * A hidden ecosystem never reaches a refusal through `parse`: the input boundary
 * drops it and falls back to the default. So the guards below go to the two
 * places that actually keep a hidden rule's message out: `rulesToStates`, where
 * it is stripped, and the ecosystem OUTPUT refine, driven directly.
 */
describe('a hidden rule’s message never reaches a refusal', () => {
  it('rulesToStates strips it on every target type, even stacked on a shown rule', () => {
    const states = rulesToStates([
      // listed first, so the hidden rule has to win the merge, not just arrive
      rule({ id: 'shown', ecosystems: ['Flux1', 'SDXL'], workflows: ['img2img'] }),
      rule({
        id: 'hidden',
        presentation: 'hidden',
        message: SECRET,
        ecosystems: ['SDXL'],
        workflows: ['txt2img'],
        modelVersionIds: [8],
      }),
    ]);
    // The shown rule keeps its copy, so a message is observable in this output.
    expect([...states.ecosystems]).toEqual([
      ['Flux1', { state: 'disabled', message: USER_COPY }],
      ['SDXL', { state: 'hidden', message: undefined }],
    ]);
    expect([...states.workflows]).toEqual([
      ['img2img', { state: 'disabled', message: USER_COPY }],
      ['txt2img', { state: 'hidden', message: undefined }],
    ]);
    expect([...states.modelVersionIds]).toEqual([[8, { state: 'hidden', message: undefined }]]);
  });

  const outputRefusals = (
    hidden: string[],
    gated: { key: string; message?: string }[],
    value: string
  ) => {
    const result = ecosystemFieldSchemas('txt2img', hidden, gated, ['SD1']).output.safeParse(value);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it('CONTROL: a gated entry’s message does reach the output refusal', () => {
    expect(outputRefusals([], [{ key: 'SDXL', message: SECRET }], 'SDXL')).toEqual([
      `${ECOSYSTEM_UNAVAILABLE}. ${SECRET}`,
    ]);
  });

  it('a hidden ecosystem at the output refine is refused with the bare text', () => {
    expect(outputRefusals(['SDXL'], [], 'SDXL')).toEqual([ECOSYSTEM_UNAVAILABLE]);
  });

  // Unreachable through getEcosystemStates today (a key is hidden OR gated); pins hidden-first ordering as hardening.
  it('invariant guard: hidden is checked first: a gated entry for the same key never adds its message', () => {
    expect(outputRefusals(['SDXL'], [{ key: 'SDXL', message: SECRET }], 'SDXL')).toEqual([
      ECOSYSTEM_UNAVAILABLE,
    ]);
  });

  const workflowRefusals = (
    hidden: string[],
    gated: { key: string; message?: string }[],
    value: string
  ) => {
    const result = workflowOutput(hidden, gated).safeParse(value);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it('CONTROL: a gated workflow entry’s message does reach the output refusal', () => {
    expect(workflowRefusals([], [{ key: 'txt2img', message: SECRET }], 'txt2img')).toEqual([
      `${WORKFLOW_UNAVAILABLE}. ${SECRET}`,
    ]);
  });

  // Unreachable through mergeGateStates today (a key is hidden OR gated); pins hidden-first ordering as hardening.
  it('invariant guard: hidden is checked first: a gated entry for the same workflow key never adds its message', () => {
    expect(workflowRefusals(['txt2img'], [{ key: 'txt2img', message: SECRET }], 'txt2img')).toEqual(
      [WORKFLOW_UNAVAILABLE]
    );
  });
});
