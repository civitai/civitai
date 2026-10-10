import { describe, expect, it } from 'vitest';

import { resolveExperimental, resolveExperimentalMatches } from './experimental';
import { experimentalTargets, gateRuleSchema, type GateRule } from './gates';

const rule = (overrides: Partial<GateRule>): GateRule =>
  gateRuleSchema.parse({
    id: 'r1',
    availableTo: 'moderators',
    presentation: 'experimental',
    ...overrides,
  });

const targetsFor = (...rules: GateRule[]) => experimentalTargets(rules);

// 'SD3' carries base-model `experimental` flags; 'Flux' does not.
const STATIC_EXPERIMENTAL_ECOSYSTEM = 'SD3';
const PLAIN_ECOSYSTEM = 'Flux';

describe('resolveExperimental', () => {
  it('returns undefined for a target no rule mentions', () => {
    const targets = targetsFor(rule({ ecosystems: ['Wan'] }));

    expect(
      resolveExperimental(targets, { kind: 'ecosystem', key: PLAIN_ECOSYSTEM })
    ).toBeUndefined();
    expect(resolveExperimental(targets, { kind: 'workflow', key: 'txt2vid' })).toBeUndefined();
    expect(resolveExperimental(targets, { kind: 'modelVersion', key: 123 })).toBeUndefined();
  });

  it('matches a model version and carries the rule message', () => {
    const targets = targetsFor(rule({ modelVersionIds: [3216500], message: 'Local weights.' }));

    const match = resolveExperimental(targets, { kind: 'modelVersion', key: 3216500 });

    expect(match?.message).toBe('Local weights.');
    expect(match?.target).toEqual({ kind: 'modelVersion', key: 3216500 });
  });

  it('matches a workflow', () => {
    const targets = targetsFor(rule({ workflows: ['img2vid:ref2vid'] }));

    expect(
      resolveExperimental(targets, { kind: 'workflow', key: 'img2vid:ref2vid' })
    ).toBeDefined();
  });

  it('matches an ecosystem on the base-model flag with no rule at all', () => {
    const match = resolveExperimental(targetsFor(), {
      kind: 'ecosystem',
      key: STATIC_EXPERIMENTAL_ECOSYSTEM,
    });

    expect(match).toBeDefined();
    expect(match?.message).toBeUndefined();
  });

  it('ignores rules that are not experimental', () => {
    const targets = targetsFor(
      rule({ presentation: 'disabled', modelVersionIds: [999] }),
      rule({ presentation: 'hidden', ecosystems: [PLAIN_ECOSYSTEM] })
    );

    expect(resolveExperimental(targets, { kind: 'modelVersion', key: 999 })).toBeUndefined();
    expect(
      resolveExperimental(targets, { kind: 'ecosystem', key: PLAIN_ECOSYSTEM })
    ).toBeUndefined();
  });

  it('keys an ecosystem and a version sharing a key apart', () => {
    const targets = targetsFor(rule({ ecosystems: ['42'], modelVersionIds: [42] }));

    const eco = resolveExperimental(targets, { kind: 'ecosystem', key: '42' });
    const version = resolveExperimental(targets, { kind: 'modelVersion', key: 42 });

    expect(eco?.key).not.toBe(version?.key);
  });
});

describe('resolveExperimentalMatches', () => {
  it('keeps only experimental candidates, in the order given', () => {
    const targets = targetsFor(
      rule({ ecosystems: ['MiniMaxH3'], message: 'Eco copy' }),
      rule({ id: 'r2', modelVersionIds: [3216500], message: 'Version copy' })
    );

    const matches = resolveExperimentalMatches(targets, [
      { kind: 'ecosystem', key: 'MiniMaxH3' },
      undefined,
      { kind: 'workflow', key: 'txt2vid' },
      { kind: 'modelVersion', key: 3216500 },
    ]);

    expect(matches.map((m) => m.message)).toEqual(['Eco copy', 'Version copy']);
  });

  it('deduplicates a target that appears twice', () => {
    const targets = targetsFor(rule({ modelVersionIds: [7] }));

    const matches = resolveExperimentalMatches(targets, [
      { kind: 'modelVersion', key: 7 },
      { kind: 'modelVersion', key: 7 },
    ]);

    expect(matches).toHaveLength(1);
  });
});
