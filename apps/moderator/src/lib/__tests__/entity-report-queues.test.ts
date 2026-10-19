import { describe, expect, it } from 'vitest';
import { chatSubject, entryTitle } from '../entity-report-queues';

/**
 * Who a chat's reports are about (`chatSubject`, `chatReportSubject`'s rule), as the queue rows and
 * the open chat both work it out.
 */

const members = [{ userId: 1 }, { userId: 2 }];
const report = (reportedById: number, alsoReportedBy: number[] = []) => ({
  reportedById,
  alsoReportedBy,
});

describe('chatSubject', () => {
  it('is the other member of a two-person chat', () => {
    expect(chatSubject(members, [report(1)])).toEqual({
      subjectIds: [2],
      rule: 'one',
      reporterIds: [1],
    });
  });

  // The main app folds the second member's report into the first: one report naming both.
  it('names nobody when the other member is a co-reporter on the same report', () => {
    expect(chatSubject(members, [report(1, [2])])).toMatchObject({
      subjectIds: [],
      rule: 'mutual',
      reporterIds: [1, 2],
    });
  });

  it('names nobody when both members filed their own reports', () => {
    expect(chatSubject(members, [report(1), report(2)])).toMatchObject({
      subjectIds: [],
      rule: 'mutual',
    });
  });

  it('names nobody when no reporter is in the chat', () => {
    expect(chatSubject(members, [report(9)])).toMatchObject({ subjectIds: [], rule: 'outsider' });
  });

  // A group report cannot be pinned on one of N members.
  it('names nobody in a group chat', () => {
    expect(chatSubject([...members, { userId: 3 }], [report(1)])).toMatchObject({
      subjectIds: [],
      rule: 'group',
    });
  });

  it('counts each reporter once across reports', () => {
    expect(chatSubject(members, [report(1, [7]), report(1)]).reporterIds).toEqual([1, 7]);
  });

  it('takes a missing co-reporter list as none', () => {
    expect(chatSubject(members, [{ reportedById: 1, alsoReportedBy: null }]).subjectIds).toEqual([
      2,
    ]);
  });
});

describe('entryTitle', () => {
  // The queue row and the header both read it, so they name an entry the same way.
  it('names the entry and its bounty', () => {
    expect(entryTitle(5, 'Music Shorts')).toBe('Entry #5 on Music Shorts');
    expect(entryTitle(5, null)).toBe('Entry #5');
  });
});
