import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { getWorkflowCapability } from '../workflow-capability';
import { ecosystems } from '~/shared/constants/basemodel.constants';
import { getWorkflowsForEcosystem } from '../config/workflows';
import { substitutionsFromNotes } from '../model-substitution';
import type { GenerationCtx } from '../context';

const UNRECOGNIZED_ID = 987654321;

function ctx(): GenerationCtx {
  return {
    limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
    user: { isMember: false, tier: 'free' },
    flags: {},
    selfHostedDisabledEcosystems: [],
    selfHostedMode: 'enabled',
    gateRules: [],
  } as GenerationCtx;
}

/**
 * The substitution metric's one tap: `validateInput` turns the hub's correction notes into
 * events. It replaced an in-parse `ext.modelSubstitutions.record()` call, and the failure
 * mode of getting it wrong is silent — the counter goes to zero rather than red.
 *
 * 🔴 THE ASSERTION IS AGAINST WHAT THE PARSE APPLIED, not against an event count. A model-locked
 * pair can correct `model` more than once in a pass (the pin's own default, then the route's,
 * where the two differ), and only the last one describes what the caller actually got. Issue
 * #3520 counts substitutions that HAPPENED, so the test reads the LAST event and checks it
 * against `state.model.id` — asserting a count would pin the intermediate states instead.
 */
describe('substitutionsFromNotes matches the substitution that actually took effect', () => {
  const pairs: Array<{ ecosystem: string; workflow: string }> = [];
  for (const eco of ecosystems) {
    for (const option of getWorkflowsForEcosystem(eco.id)) {
      const cap = getWorkflowCapability(eco.key, option.graphKey);
      if (!cap?.modelLocked || !cap.defaultModelId) continue;
      pairs.push({ ecosystem: eco.key, workflow: option.graphKey });
    }
  }

  it('has locked pairs to test', () => {
    expect(pairs.length).toBeGreaterThan(10);
  });

  it('records the applied id the parse really resolved to, on every locked pair', () => {
    const wrong: string[] = [];
    let recorded = 0;
    for (const pair of pairs) {
      const input = {
        workflow: pair.workflow,
        ecosystem: pair.ecosystem,
        prompt: 'a cat',
        model: { id: UNRECOGNIZED_ID, model: { type: 'Checkpoint' } },
      };
      const result = generationHub.parse(input as never, ctx() as never);
      const state = (result.success ? result.state : {}) as {
        ecosystem?: string;
        workflow?: string;
        model?: { id?: number };
      };
      const events = substitutionsFromNotes(result.notes, {
        ecosystem: state.ecosystem ?? pair.ecosystem,
        workflow: state.workflow ?? pair.workflow,
      });
      const appliedId = state.model?.id;
      if (!events.length) continue;
      recorded++;
      const ev = events[events.length - 1];
      if (ev.requested !== UNRECOGNIZED_ID)
        wrong.push(`${pair.ecosystem}/${pair.workflow}: requested ${ev.requested}`);
      if (appliedId !== undefined && ev.applied !== appliedId)
        wrong.push(
          `${pair.ecosystem}/${pair.workflow}: recorded applied=${ev.applied} but the parse resolved model ${appliedId}`
        );
    }
    expect(wrong).toEqual([]);
    expect(recorded, 'no locked pair produced an event — the tap is inert').toBeGreaterThan(5);
  });

  // EVERY model-locked pair, not a sample: an unrecognized id on a locked picker always
  // substitutes, so a pair that records nothing is a pair whose substitution went unobserved.
  it('records on EVERY locked pair, with no silent ones', () => {
    const silent: string[] = [];
    for (const pair of pairs) {
      const result = generationHub.parse(
        {
          workflow: pair.workflow,
          ecosystem: pair.ecosystem,
          prompt: 'a cat',
          model: { id: UNRECOGNIZED_ID, model: { type: 'Checkpoint' } },
        } as never,
        ctx() as never
      );
      const state = (result.success ? result.state : {}) as {
        ecosystem?: string;
        workflow?: string;
      };
      if (
        !substitutionsFromNotes(result.notes, {
          ecosystem: state.ecosystem ?? pair.ecosystem,
          workflow: state.workflow ?? pair.workflow,
        }).length
      )
        silent.push(`${pair.ecosystem}/${pair.workflow}`);
    }
    expect(silent).toEqual([]);
    expect(pairs.length).toBeGreaterThanOrEqual(116);
  });
});
