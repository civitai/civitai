import { describe, expect, it } from 'vitest';
import { processDefinitionSchema } from './process-definition';

const valid = () => ({
  key: 'test-notice',
  title: 'Test notice',
  mailbox: 'inbox@example.test',
  fields: [
    { id: 'urls', label: 'Links', kind: 'urlList', required: true },
    { id: 'statement', label: 'Statement', kind: 'textarea' },
  ],
  checklist: [{ id: 'complete', label: 'The notice is complete' }],
  states: [
    { id: 'received', label: 'Received' },
    { id: 'removed', label: 'Removed' },
    { id: 'disputed', label: 'Disputed', needsReview: true },
    { id: 'closed', label: 'Closed', terminal: true },
  ],
  initialState: 'received',
  transitions: [
    {
      id: 'remove',
      from: 'received',
      to: 'removed',
      label: 'Remove',
      requires: ['complete'],
      effects: [
        { kind: 'removeTargets' },
        { kind: 'sendNotice', notice: 'to-uploader' },
        { kind: 'startClock', clock: 'restore-window' },
      ],
    },
  ],
  clocks: [{ id: 'restore-window', label: 'Restore window', businessDays: 10 }],
  notices: [
    {
      id: 'to-uploader',
      recipientRole: 'uploader',
      subject: 'About case {caseRef}',
      body: 'We removed:\n{items}\nReply here: {continueLink}',
    },
  ],
  publicActions: [
    {
      id: 'dispute',
      role: 'uploader',
      label: 'Dispute',
      fields: ['statement'],
      records: 'disputed',
      moveTo: 'disputed',
    },
  ],
});

const errors = (raw: unknown) => {
  const r = processDefinitionSchema.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('processDefinitionSchema', () => {
  it('accepts a well-formed definition', () => {
    expect(errors(valid())).toEqual([]);
  });

  it('refuses effects on a public action, so a claimant or uploader cannot remove or restore content', () => {
    const d = valid();
    Object.assign(d.publicActions[0], { effects: [{ kind: 'restoreTargets' }] });
    expect(errors(d).join()).toMatch(/effects/);
  });

  it('refuses a public action that moves a case into a state that is not under review', () => {
    const d = valid();
    d.publicActions[0].moveTo = 'closed';
    expect(errors(d)).toContain('a public action may only move a case into a needsReview state');
  });

  it('refuses an effect kind outside the fixed set', () => {
    const d = valid();
    (d.transitions[0].effects as unknown[]).push({ kind: 'runScript', script: 'x' });
    expect(errors(d).length).toBeGreaterThan(0);
  });

  it('refuses a notice slot outside the allowed set', () => {
    const d = valid();
    d.notices[0].body += ' {submitterEmail}';
    expect(errors(d).join()).toMatch(/unknown slot \{submitterEmail\}/);
  });

  it('refuses references to states, notices, clocks and checklist items that do not exist', () => {
    const d = valid();
    d.transitions[0].to = 'gone';
    d.transitions[0].requires = ['missing'];
    d.transitions[0].effects = [
      { kind: 'sendNotice', notice: 'nope' },
      { kind: 'startClock', clock: 'nope' },
    ] as (typeof d.transitions)[0]['effects'];
    expect(errors(d)).toEqual(
      expect.arrayContaining([
        'unknown state "gone"',
        'unknown checklist item "missing"',
        'unknown notice "nope"',
        'unknown clock "nope"',
      ])
    );
  });

  it('refuses a reroute to another process unless the same transition escalates to Legal', () => {
    const d = valid();
    const reroute = { kind: 'rerouteTo', process: 'other-process' };
    d.transitions[0].effects = [reroute] as (typeof d.transitions)[0]['effects'];
    expect(errors(d)).toContain('a reroute must also escalate to Legal');
    d.transitions[0].effects = [
      reroute,
      { kind: 'escalateToLegal' },
    ] as (typeof d.transitions)[0]['effects'];
    expect(errors(d)).toEqual([]);
  });

  it('holds a transition behind a clock window only when that clock has one, opening before its deadline', () => {
    const d = valid();
    Object.assign(d.transitions[0], { notBefore: 'restore-window' });
    expect(errors(d)).toContain('clock "restore-window" has no opensAfter');
    Object.assign(d.clocks[0], { opensAfter: 10 });
    expect(errors(d)).toContain('a window must open before its deadline');
    Object.assign(d.clocks[0], { businessDays: 14 });
    expect(errors(d)).toEqual([]);
  });

  it('refuses a transition out of a terminal state', () => {
    const d = valid();
    d.transitions[0].from = 'closed';
    expect(errors(d)).toContain('"closed" is terminal');
  });

  it('refuses duplicate ids', () => {
    const d = valid();
    d.states.push({ id: 'received', label: 'Again' });
    expect(errors(d)).toContain('duplicate id "received"');
  });
});
