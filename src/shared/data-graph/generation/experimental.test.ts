import { describe, expect, it } from 'vitest';

import {
  experimentalDismissId,
  liveExperimentalDismissIds,
  resolveExperimental,
  resolveExperimentalMatches,
  type ExperimentalTarget,
} from './experimental';
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
});

describe('experimentalDismissId', () => {
  const target: ExperimentalTarget = { kind: 'modelVersion', key: 3216500 };

  it('is stable for the same message', () => {
    expect(experimentalDismissId(target, 'Same copy')).toBe(
      experimentalDismissId(target, 'Same copy')
    );
  });

  // The property the whole design rests on: an edited warning re-notifies
  // everyone who dismissed the previous wording.
  it('changes when the message changes', () => {
    expect(experimentalDismissId(target, 'Original copy')).not.toBe(
      experimentalDismissId(target, 'Original copy, plus a new caveat')
    );
  });

  it('does not collide across kinds that share a key', () => {
    const ids = [
      experimentalDismissId({ kind: 'ecosystem', key: '42' }),
      experimentalDismissId({ kind: 'workflow', key: '42' }),
      experimentalDismissId({ kind: 'modelVersion', key: 42 }),
    ];

    expect(new Set(ids).size).toBe(3);
  });

  it('distinguishes a message from no message', () => {
    expect(experimentalDismissId(target)).not.toBe(experimentalDismissId(target, 'Some copy'));
  });
});

// A dismissal is pruned against this set, so anything MISSING here is a
// dismissal silently discarded — the warning reappears for someone who
// dismissed it. Every id `resolveExperimental` can hand out has to be in it.
describe('liveExperimentalDismissIds', () => {
  it('contains the id of every live target, exactly as resolved', () => {
    const rules = [
      rule({ ecosystems: ['MiniMaxH3'], message: 'Eco copy' }),
      rule({ id: 'r2', workflows: ['img2vid:ref2vid'] }),
      rule({ id: 'r3', modelVersionIds: [3216500], message: 'Version copy' }),
    ];
    const targets = targetsFor(...rules);
    const live = liveExperimentalDismissIds(targets);

    const candidates: ExperimentalTarget[] = [
      { kind: 'ecosystem', key: 'MiniMaxH3' },
      { kind: 'workflow', key: 'img2vid:ref2vid' },
      { kind: 'modelVersion', key: 3216500 },
      { kind: 'ecosystem', key: STATIC_EXPERIMENTAL_ECOSYSTEM },
    ];

    for (const candidate of candidates) {
      const match = resolveExperimental(targets, candidate);
      expect(match, `${candidate.kind}:${candidate.key} should resolve`).toBeDefined();
      expect(live).toContain(match!.dismissId);
    }
  });

  it('includes statically experimental ecosystems with no rule', () => {
    const live = liveExperimentalDismissIds(targetsFor());

    expect(live).toContain(
      experimentalDismissId({ kind: 'ecosystem', key: STATIC_EXPERIMENTAL_ECOSYSTEM })
    );
  });

  it('omits an ecosystem that is neither ruled nor flagged', () => {
    const live = liveExperimentalDismissIds(targetsFor());

    expect(live).not.toContain(experimentalDismissId({ kind: 'ecosystem', key: PLAIN_ECOSYSTEM }));
  });

  // The orphan-collection property: a previous message's id is NOT live, so a
  // dismissal of the old wording gets pruned and the new wording re-notifies.
  it('omits the id of a superseded message', () => {
    const targets = targetsFor(rule({ modelVersionIds: [7], message: 'New copy' }));
    const live = liveExperimentalDismissIds(targets);

    expect(live).toContain(experimentalDismissId({ kind: 'modelVersion', key: 7 }, 'New copy'));
    expect(live).not.toContain(experimentalDismissId({ kind: 'modelVersion', key: 7 }, 'Old copy'));
  });

  it('ignores rules that are not experimental', () => {
    const live = liveExperimentalDismissIds(
      targetsFor(rule({ presentation: 'disabled', modelVersionIds: [999] }))
    );

    expect(live).not.toContain(experimentalDismissId({ kind: 'modelVersion', key: 999 }));
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
