import { describe, expect, it } from 'vitest';
import type { GateRule } from './gates';
import { applicableRulesFor, experimentalTargets, mergeGateStates, rulesToStates } from './gates';

const rule = (overrides: Partial<GateRule>): GateRule => ({
  id: 'r1',
  name: 'test',
  availableTo: 'nobody',
  presentation: 'disabled',
  message: undefined,
  ecosystems: [],
  workflows: [],
  modelVersionIds: [],
  ...overrides,
});

describe('experimental rules', () => {
  const experimental = rule({
    presentation: 'experimental',
    ecosystems: ['Flux1'],
    workflows: ['txt2img'],
    modelVersionIds: [123],
  });

  it('gates nothing — no target reaches the state map', () => {
    const states = rulesToStates([experimental]);
    expect(states.ecosystems.get('Flux1')).toBeUndefined();
    expect(states.workflows.get('txt2img')).toBeUndefined();
    expect(states.modelVersionIds.get(123)).toBeUndefined();
  });

  it('leaves the picker split empty, so nothing is hidden or badged', () => {
    const { hidden, states } = mergeGateStates(undefined, rulesToStates([experimental]).workflows);
    expect(hidden).toEqual([]);
    expect(states).toEqual([]);
  });

  it('collects its targets with the rule message', () => {
    const targets = experimentalTargets([{ ...experimental, message: 'still cooking' }]);
    expect(targets.ecosystems.get('Flux1')).toBe('still cooking');
    expect(targets.workflows.get('txt2img')).toBe('still cooking');
    expect(targets.modelVersionIds.get(123)).toBe('still cooking');
  });

  it('does not weaken a real gate on the same target', () => {
    const states = rulesToStates([
      experimental,
      rule({ id: 'r2', presentation: 'hidden', ecosystems: ['Flux1'] }),
    ]);
    expect(states.ecosystems.get('Flux1')?.state).toBe('hidden');
  });

  it('is ignored by experimentalTargets when the rule is a real gate', () => {
    const targets = experimentalTargets([rule({ presentation: 'hidden', ecosystems: ['Flux1'] })]);
    expect(targets.ecosystems.size).toBe(0);
  });

  // `availableTo` names who keeps ACCESS, and experimental grants none — so it
  // has no exempt tier. A mod/member/tester must still get the warning even
  // though a gate rule with the same `availableTo` would skip them.
  it.each([
    ['moderators', { isModerator: true, isMember: true, hasTestingAccess: true }],
    ['members', { isModerator: false, isMember: true, hasTestingAccess: false }],
    ['testers', { isModerator: false, isMember: false, hasTestingAccess: true }],
  ] as const)('survives applicableRulesFor for the %s tier', (availableTo, user) => {
    const rules = [
      { ...experimental, availableTo },
      rule({ id: 'r2', availableTo, presentation: 'disabled', ecosystems: ['Flux1'] }),
    ];

    const applicable = applicableRulesFor(rules, user);

    expect(applicable.map((r) => r.id)).toEqual(['r1']); // the gate dropped, the warning didn't
    expect(experimentalTargets(applicable).ecosystems.has('Flux1')).toBe(true);
  });
});
