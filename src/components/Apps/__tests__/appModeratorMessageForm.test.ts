import { describe, expect, it } from 'vitest';

import {
  modMessageBodyState,
  modMessageGate,
  modMessagePayload,
  modMessageSentSummary,
  modMessageSubjectState,
} from '~/components/Apps/appModeratorMessageForm';
import {
  MOD_MESSAGE_BODY_MAX,
  MOD_MESSAGE_BODY_MIN,
  MOD_MESSAGE_SUBJECT_MAX,
  MOD_MESSAGE_SUBJECT_MIN,
} from '~/server/schema/blocks/app-moderator-message.schema';

/**
 * The BLOCKING gate on the moderator → app-developer message composer.
 *
 * `MessageAppOwnerModal` is covered by a browser suite too, but the browser project is
 * REPORT-ONLY in this repo's CI, so the rule that decides whether a half-typed message
 * can be sent to a developer is pinned here, in the node `unit` project, exactly as
 * `appListingModerationTableView.test.ts` pins the action set.
 *
 * 🔴 EVERY BOUNDARY CASE IS BUILT FROM THE SCHEMA CONSTANTS, not from the literals 3 /
 * 200 / 20 / 2000. A test that hardcodes them keeps passing when the schema moves and
 * the UI does not — which is the precise defect this file exists to prevent.
 */

const A = (n: number) => 'a'.repeat(n);
const okSubject = A(MOD_MESSAGE_SUBJECT_MIN);
const okBody = A(MOD_MESSAGE_BODY_MIN);

describe('the constants this file measures against are actually distinct', () => {
  // A positive control on the FIXTURES: if the subject and body floors were equal, a
  // mutant swapping one for the other would survive every assertion below. They are
  // not (3 vs 20), and this pins that they must stay unequal for this suite to
  // discriminate at all.
  it('the subject and body floors differ, and each floor is below its ceiling', () => {
    expect(MOD_MESSAGE_SUBJECT_MIN).not.toBe(MOD_MESSAGE_BODY_MIN);
    expect(MOD_MESSAGE_SUBJECT_MAX).not.toBe(MOD_MESSAGE_BODY_MAX);
    expect(MOD_MESSAGE_SUBJECT_MIN).toBeLessThan(MOD_MESSAGE_SUBJECT_MAX);
    expect(MOD_MESSAGE_BODY_MIN).toBeLessThan(MOD_MESSAGE_BODY_MAX);
  });
});

describe('modMessageSubjectState / modMessageBodyState', () => {
  it('measures the TRIMMED length', () => {
    // The service trims before it validates, so whitespace padding must not be
    // counted toward the floor — a body of N spaces is an empty message.
    expect(modMessageBodyState(' '.repeat(MOD_MESSAGE_BODY_MIN + 10)).length).toBe(0);
    expect(modMessageBodyState(`  ${okBody}  `).length).toBe(MOD_MESSAGE_BODY_MIN);
  });

  it('a subject one character under the floor is tooShort; exactly at the floor is ok', () => {
    const under = modMessageSubjectState(A(MOD_MESSAGE_SUBJECT_MIN - 1));
    expect(under.tooShort).toBe(true);
    expect(under.ok).toBe(false);

    const at = modMessageSubjectState(A(MOD_MESSAGE_SUBJECT_MIN));
    expect(at.tooShort).toBe(false);
    expect(at.ok).toBe(true);
  });

  it('a subject exactly at the ceiling is ok; one over is tooLong', () => {
    expect(modMessageSubjectState(A(MOD_MESSAGE_SUBJECT_MAX)).ok).toBe(true);
    const over = modMessageSubjectState(A(MOD_MESSAGE_SUBJECT_MAX + 1));
    expect(over.tooLong).toBe(true);
    expect(over.ok).toBe(false);
  });

  it('a body one character under the floor is tooShort; exactly at the floor is ok', () => {
    expect(modMessageBodyState(A(MOD_MESSAGE_BODY_MIN - 1)).tooShort).toBe(true);
    expect(modMessageBodyState(A(MOD_MESSAGE_BODY_MIN)).ok).toBe(true);
  });

  it('a body exactly at the ceiling is ok; one over is tooLong', () => {
    expect(modMessageBodyState(A(MOD_MESSAGE_BODY_MAX)).ok).toBe(true);
    expect(modMessageBodyState(A(MOD_MESSAGE_BODY_MAX + 1)).tooLong).toBe(true);
  });

  it('reports the bounds it measured against, so a caller cannot re-derive them wrong', () => {
    expect(modMessageSubjectState('x')).toMatchObject({
      min: MOD_MESSAGE_SUBJECT_MIN,
      max: MOD_MESSAGE_SUBJECT_MAX,
    });
    expect(modMessageBodyState('x')).toMatchObject({
      min: MOD_MESSAGE_BODY_MIN,
      max: MOD_MESSAGE_BODY_MAX,
    });
  });
});

describe('modMessageGate', () => {
  it('opens only when BOTH fields clear BOTH bounds', () => {
    expect(modMessageGate({ subject: okSubject, body: okBody })).toEqual({
      open: true,
      blockedBy: null,
      tooltip: undefined,
    });
  });

  it('an empty form is blocked on the subject', () => {
    const gate = modMessageGate({ subject: '', body: '' });
    expect(gate.open).toBe(false);
    expect(gate.blockedBy).toBe('subject-too-short');
    expect(gate.tooltip).toContain(String(MOD_MESSAGE_SUBJECT_MIN));
  });

  /**
   * 🔴 THE CASE THE UI EXISTS TO CATCH, and the one a floor-only gate gets wrong: a
   * moderator pastes a long message. Every field clears its floor, so a
   * `length >= min`-only check enables the button — and the send comes back a
   * BAD_REQUEST with the text still in the box and no indication which field was at
   * fault. Both ceilings must close the gate.
   */
  it('blocks an over-length BODY even though every floor is cleared', () => {
    const gate = modMessageGate({ subject: okSubject, body: A(MOD_MESSAGE_BODY_MAX + 1) });
    expect(gate.open).toBe(false);
    expect(gate.blockedBy).toBe('body-too-long');
    expect(gate.tooltip).toContain(String(MOD_MESSAGE_BODY_MAX));
  });

  it('blocks an over-length SUBJECT even though every floor is cleared', () => {
    const gate = modMessageGate({ subject: A(MOD_MESSAGE_SUBJECT_MAX + 1), body: okBody });
    expect(gate.open).toBe(false);
    expect(gate.blockedBy).toBe('subject-too-long');
    expect(gate.tooltip).toContain(String(MOD_MESSAGE_SUBJECT_MAX));
  });

  it('blocks a body that is long enough for the SUBJECT floor but not the BODY floor', () => {
    // The discriminating fixture: `MOD_MESSAGE_SUBJECT_MIN` characters satisfies the
    // subject and NOT the body. A gate that reused one floor for both fields passes
    // every same-length fixture and dies here.
    const gate = modMessageGate({ subject: okSubject, body: A(MOD_MESSAGE_SUBJECT_MIN) });
    expect(gate.open).toBe(false);
    expect(gate.blockedBy).toBe('body-too-short');
  });

  it('a whitespace-only body cannot open the gate', () => {
    const gate = modMessageGate({
      subject: okSubject,
      body: ' '.repeat(MOD_MESSAGE_BODY_MIN + 5),
    });
    expect(gate.open).toBe(false);
    expect(gate.blockedBy).toBe('body-too-short');
  });

  it('reports the SUBJECT first when both fields are blocked (it is the first input)', () => {
    expect(modMessageGate({ subject: '', body: '' }).blockedBy).toBe('subject-too-short');
  });

  it('a closed gate always carries a tooltip, and an open one never does', () => {
    const closed = [
      { subject: '', body: okBody },
      { subject: okSubject, body: '' },
      { subject: A(MOD_MESSAGE_SUBJECT_MAX + 1), body: okBody },
      { subject: okSubject, body: A(MOD_MESSAGE_BODY_MAX + 1) },
    ];
    for (const input of closed) {
      const gate = modMessageGate(input);
      expect(gate.open).toBe(false);
      expect(gate.tooltip).toBeTruthy();
    }
    expect(modMessageGate({ subject: okSubject, body: okBody }).tooltip).toBeUndefined();
  });
});

describe('modMessagePayload', () => {
  it('trims both fields — the service audits the TRIMMED text', () => {
    expect(
      modMessagePayload({
        appListingId: 'apl_1',
        subject: `  ${okSubject}  `,
        body: `\n${okBody}\n`,
        includeCollaborators: false,
      })
    ).toEqual({ appListingId: 'apl_1', subject: okSubject, body: okBody });
  });

  it('omits includeCollaborators when off, and sends `true` when on', () => {
    const off = modMessagePayload({
      appListingId: 'apl_1',
      subject: okSubject,
      body: okBody,
      includeCollaborators: false,
    });
    expect('includeCollaborators' in off).toBe(false);

    const on = modMessagePayload({
      appListingId: 'apl_1',
      subject: okSubject,
      body: okBody,
      includeCollaborators: true,
    });
    expect(on.includeCollaborators).toBe(true);
  });

  it('passes the listing id through UNCHANGED (the proc resolves a revision id itself)', () => {
    // A shadow revision id must reach the server as written — the service hops it to
    // the parent. Any client-side "normalisation" here would be a second, drift-capable
    // implementation of a rule the server already owns.
    expect(
      modMessagePayload({
        appListingId: 'rev_01JABCDEF',
        subject: okSubject,
        body: okBody,
        includeCollaborators: false,
      }).appListingId
    ).toBe('rev_01JABCDEF');
  });
});

describe('modMessageSentSummary', () => {
  it('says "the app owner" for a single recipient', () => {
    expect(modMessageSentSummary(1)).toBe('Message sent to the app owner.');
  });

  it('names the COUNT once collaborators were looped in', () => {
    // The count is the only signal a moderator gets that a message they may have
    // intended for one person reached several.
    expect(modMessageSentSummary(3)).toContain('3');
    expect(modMessageSentSummary(3)).not.toContain('the app owner');
  });
});
