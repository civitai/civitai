import { describe, expect, it } from 'vitest';
import { ruleVersionDiff, sameRuleState, type RuleStateView } from './model-rule-versions';

const state = (patch: Partial<RuleStateView> = {}): RuleStateView => ({
  subject: 'Example',
  description: 'Desc',
  aliases: ['One', 'Two'],
  note: '',
  enabled: true,
  ...patch,
});

describe('ruleVersionDiff', () => {
  it('lists every field, marking only the ones that differ', () => {
    const rows = ruleVersionDiff(state(), state({ aliases: ['One'], enabled: false }));
    expect(rows.map((r) => [r.field, r.changed])).toEqual([
      ['Subject', false],
      ['Description', false],
      ['Aliases', true],
      ['Internal note', false],
      ['Enabled', true],
      ['Needs attention', false],
    ]);
    expect(rows[2]).toMatchObject({ before: 'One\nTwo', after: 'One' });
    expect(rows[4]).toMatchObject({ before: 'Yes', after: 'No' });
  });

  it('shows a needs-attention flag that appears or clears between versions', () => {
    const rows = ruleVersionDiff(state({ needsAttention: true }), state());
    expect(rows.at(-1)).toMatchObject({
      field: 'Needs attention',
      before: 'Yes',
      after: 'No',
      changed: true,
    });
    expect(sameRuleState(state({ needsAttention: true }), state())).toBe(false);
  });
});

describe('sameRuleState', () => {
  it('is true only when nothing a moderator sees would change', () => {
    expect(sameRuleState(state(), state())).toBe(true);
    expect(sameRuleState(state(), state({ enabled: false }))).toBe(false);
    expect(sameRuleState(state(), state({ note: 'n' }))).toBe(false);
    expect(sameRuleState(state(), state({ aliases: ['Two', 'One'] }))).toBe(false);
  });
});
