import { describe, expect, it } from 'vitest';
import type { GateRule } from './gates';
import type { GateSelectionVersion } from './gates';
import {
  applicableRulesFor,
  canGenerateBlockedTargets,
  disabledSelectionGates,
  experimentalTargets,
  gatedSelectionRefusal,
  matchesGateCondition,
  selectionGates,
  mergeGateStates,
  rulesToStates,
  unselectableVersionIds,
} from './gates';

const rule = (overrides: Partial<GateRule>): GateRule => ({
  id: 'r1',
  name: 'test',
  availableTo: 'nobody',
  presentation: 'disabled',
  message: undefined,
  conditions: [],
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

describe('canGenerateBlockedTargets', () => {
  it('blocks hidden ecosystems and versions', () => {
    const blocked = canGenerateBlockedTargets([
      rule({ presentation: 'hidden', ecosystems: ['Flux1'], modelVersionIds: [123] }),
    ]);
    expect([...blocked.ecosystems]).toEqual(['Flux1']);
    expect([...blocked.versionIds]).toEqual([123]);
  });

  it('leaves disabled and members-only targets selectable', () => {
    const blocked = canGenerateBlockedTargets([
      rule({ presentation: 'disabled', ecosystems: ['SDXL'], modelVersionIds: [123] }),
      rule({ id: 'r2', presentation: 'disabled', availableTo: 'members', modelVersionIds: [456] }),
    ]);
    expect(blocked.ecosystems.size + blocked.versionIds.size).toBe(0);
  });

  it('blocks nothing for an experimental rule', () => {
    const blocked = canGenerateBlockedTargets([
      rule({ presentation: 'experimental', ecosystems: ['Flux1'], modelVersionIds: [123] }),
    ]);
    expect(blocked.ecosystems.size).toBe(0);
    expect(blocked.versionIds.size).toBe(0);
  });
});

// The whole point of `disabled`: the pickers keep offering it, so the form can
// say why generation is blocked instead of the item vanishing.
describe('unselectableVersionIds', () => {
  it('keeps a disabled version in the pickers and removes every other gated state', () => {
    const ids = unselectableVersionIds([
      rule({ presentation: 'disabled', modelVersionIds: [1] }),
      rule({ id: 'r2', presentation: 'hidden', modelVersionIds: [2] }),
      rule({ id: 'r3', presentation: 'disabled', availableTo: 'members', modelVersionIds: [3] }),
    ]);

    expect(ids).not.toContain(1);
    expect(ids).toEqual(expect.arrayContaining([2, 3]));
  });

  it('removes nothing for an experimental rule', () => {
    expect(
      unselectableVersionIds([rule({ presentation: 'experimental', modelVersionIds: [1] })])
    ).toEqual([]);
  });
});

describe('condition rules', () => {
  const coldCheckpointRule = rule({
    id: 'members-load',
    availableTo: 'members',
    presentation: 'disabled',
    conditions: ['coldCheckpoint'],
  });

  const version = (overrides: Partial<GateSelectionVersion> = {}): GateSelectionVersion => ({
    id: 501,
    modelType: 'Checkpoint',
    generatorLoaded: false,
    ...overrides,
  });

  it('gates a checkpoint that is not resident', () => {
    expect(matchesGateCondition('coldCheckpoint', version())).toBe(true);
  });

  it('leaves a resident checkpoint alone — the whole point is that loaded models stay open', () => {
    expect(matchesGateCondition('coldCheckpoint', version({ generatorLoaded: true }))).toBe(false);
  });

  it('leaves every other type alone, resident or not', () => {
    for (const modelType of ['LORA', 'TextualInversion', 'VAE'])
      expect(matchesGateCondition('coldCheckpoint', version({ modelType }))).toBe(false);
  });

  // An ExternalGeneration version has no weights to become resident, so the column is false for it
  // forever. Reading it directly here would gate every API model behind a download that never comes.
  it('leaves an API checkpoint alone, though its column says cold', () => {
    expect(
      matchesGateCondition(
        'coldCheckpoint',
        version({ generatorLoaded: false, usageControl: 'ExternalGeneration' })
      )
    ).toBe(false);
  });

  it('refuses a selection carrying a cold checkpoint, with the members copy', () => {
    const refusal = gatedSelectionRefusal([coldCheckpointRule], { versions: [version()] });
    expect(refusal).toContain('only available to members');
  });

  it('does not refuse the same selection once the model is resident', () => {
    expect(
      gatedSelectionRefusal([coldCheckpointRule], {
        versions: [version({ generatorLoaded: true })],
      })
    ).toBeUndefined();
  });

  // `versionIds` cannot answer a condition — it carries no type and no residency — so a caller that
  // passes ids only must not be silently gated by a rule it cannot evaluate.
  it('ignores condition rules for a selection that passes bare ids', () => {
    expect(gatedSelectionRefusal([coldCheckpointRule], { versionIds: [501] })).toBeUndefined();
  });

  it('takes the stronger of a condition and an id rule on the same version', () => {
    const hiddenById = rule({
      id: 'hide-501',
      availableTo: 'nobody',
      presentation: 'hidden',
      modelVersionIds: [501],
    });
    const [gate] = selectionGates([coldCheckpointRule, hiddenById], { versions: [version()] });
    expect(gate.state).toBe('hidden');
  });
  // Rules reach the graph from Redis and from fixtures without passing through the schema, so a
  // field added later is simply absent on every rule stored before it — `.default([])` never fires.
  // Iterating it unguarded threw `rule.conditions is not iterable` across 2,535 tests.
  it('tolerates a rule stored before conditions existed', () => {
    const stored = { ...rule({ ecosystems: ['Qwen'] }) } as Partial<GateRule>;
    delete stored.conditions;
    expect(() => rulesToStates([stored as GateRule])).not.toThrow();
    expect(rulesToStates([stored as GateRule]).ecosystems.get('Qwen')?.state).toBe('disabled');
  });
});

describe('gatedSelectionRefusal', () => {
  it('refuses a disabled version, with the rule message appended', () => {
    const rules = [
      rule({ presentation: 'disabled', modelVersionIds: [123], message: 'Back Monday.' }),
    ];
    expect(gatedSelectionRefusal(rules, { versionIds: [5, 123] })).toBe(
      'This model version is currently unavailable. Back Monday.'
    );
  });

  it('refuses a disabled ecosystem and workflow in their own words', () => {
    const rules = [
      rule({ presentation: 'disabled', ecosystems: ['Flux1'] }),
      rule({ id: 'r2', presentation: 'disabled', workflows: ['txt2img'] }),
    ];

    expect(gatedSelectionRefusal(rules, { ecosystem: 'Flux1' })).toBe(
      'This base model is currently unavailable.'
    );
    expect(gatedSelectionRefusal(rules, { workflow: 'txt2img' })).toBe(
      'This workflow is currently unavailable.'
    );
  });

  it('refuses a members-only target with the members copy', () => {
    const rules = [
      rule({ presentation: 'disabled', availableTo: 'members', modelVersionIds: [123] }),
    ];
    expect(gatedSelectionRefusal(rules, { versionIds: [123] })).toBe(
      'This model version is only available to members.'
    );
  });

  it('passes a selection no gating rule targets', () => {
    const rules = [
      rule({ presentation: 'disabled', modelVersionIds: [999] }),
      rule({ id: 'r2', presentation: 'experimental', modelVersionIds: [123] }),
    ];
    expect(
      gatedSelectionRefusal(rules, { ecosystem: 'SDXL', workflow: 'txt2img', versionIds: [123] })
    ).toBeUndefined();
  });
});

describe('disabledSelectionGates', () => {
  // The client blocks whatIf + submit on these alone: every other gated state
  // is either absent from the pickers or refused by the graph.
  it('reports only the disabled targets', () => {
    const gates = disabledSelectionGates(
      [
        rule({ presentation: 'disabled', ecosystems: ['Flux1'] }),
        rule({ id: 'r2', presentation: 'disabled', availableTo: 'members', modelVersionIds: [1] }),
        rule({ id: 'r3', presentation: 'hidden', workflows: ['txt2img'] }),
      ],
      { ecosystem: 'Flux1', workflow: 'txt2img', versionIds: [1] }
    );

    expect(gates).toEqual([{ subject: 'ecosystem', state: 'disabled', message: undefined }]);
  });
});
