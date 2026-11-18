import { describe, expect, it } from 'vitest';
import { blockWorkflowBodySchema } from '~/server/schema/blocks/workflow.schema';
import { REGISTERED_STEP_IDS } from '~/server/services/blocks/steps';

/**
 * `accountType` — the Buzz pool tried first — on the three `kind:'step'` /
 * `kind:'workflow'` bodies, the way `textToImage` already carries it. Each body is
 * `.strict()`, so before this field existed every one of them REFUSED it as an
 * unknown key; that refusal is what the "accepted" cases below were red against.
 *
 * The router decides what a pick MEANS (preferred-first, domain-clamped); the wire
 * only bounds it to the spendable enum (`blue | green | yellow`).
 */

const registeredStep = (over: Record<string, unknown> = {}) => ({
  kind: 'step',
  step: REGISTERED_STEP_IDS[0],
  params: {},
  ...over,
});
const passThroughStep = (over: Record<string, unknown> = {}) => ({
  kind: 'step',
  $type: 'imageBackgroundRemoval',
  input: { image: 'https://image.civitai.com/a.jpeg' },
  maxBuzz: 10,
  ...over,
});
const multiStep = (over: Record<string, unknown> = {}) => ({
  kind: 'workflow',
  steps: [
    { $type: 'imageBackgroundRemoval', input: { image: 'https://image.civitai.com/a.jpeg' } },
  ],
  ...over,
});

const ARMS = [
  ['the registered-step arm', registeredStep],
  ['the pass-through arm', passThroughStep],
  ["the kind:'workflow' body (per workflow)", multiStep],
] as const;

describe('accountType on step and workflow bodies', () => {
  describe.each(ARMS)('%s', (_name, make) => {
    it.each(['blue', 'green', 'yellow'] as const)('accepts %s and keeps it', (accountType) => {
      const parsed = blockWorkflowBodySchema.safeParse(make({ accountType }));
      expect(parsed.success).toBe(true);
      expect(parsed.success && (parsed.data as { accountType?: string }).accountType).toBe(
        accountType
      );
    });

    it('still parses with no accountType (Auto)', () => {
      const parsed = blockWorkflowBodySchema.safeParse(make());
      expect(parsed.success).toBe(true);
      expect(parsed.success && 'accountType' in parsed.data).toBe(false);
    });

    // `red` is a real pool but disabled for spend; `purple` is not a pool at all.
    it.each(['red', 'purple', 'Yellow', '', 1])('refuses %s at path accountType', (accountType) => {
      const parsed = blockWorkflowBodySchema.safeParse(make({ accountType }));
      expect(parsed.success).toBe(false);
      expect(
        parsed.success === false &&
          parsed.error.issues.some((i) => i.path.length === 1 && i.path[0] === 'accountType')
      ).toBe(true);
    });
  });

  // The multi-step pick is per WORKFLOW: a step still refuses one. (An invariant
  // guard — green before this change too; it pins that the field went on the body.)
  it("refuses accountType on a kind:'workflow' STEP", () => {
    const parsed = blockWorkflowBodySchema.safeParse(
      multiStep({
        steps: [
          {
            $type: 'imageBackgroundRemoval',
            input: { image: 'https://image.civitai.com/a.jpeg' },
            accountType: 'green',
          },
        ],
      })
    );
    expect(parsed.success).toBe(false);
  });

  // The pass-through `input` is forwarded unmodified: the field is the body's, never
  // folded into the orchestrator input.
  it('does not move accountType into the pass-through input', () => {
    const parsed = blockWorkflowBodySchema.safeParse(passThroughStep({ accountType: 'green' }));
    expect(parsed.success && (parsed.data as { input: unknown }).input).toEqual({
      image: 'https://image.civitai.com/a.jpeg',
    });
  });
});
