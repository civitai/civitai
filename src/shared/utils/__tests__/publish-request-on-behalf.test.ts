import { describe, expect, it } from 'vitest';
import {
  hasOnBehalfRecord,
  readOnBehalf,
  staffSubmissionLabel,
  staffSubmissionOf,
} from '~/shared/utils/publish-request-on-behalf';

/** Reading back `fileSummary.onBehalf`, and the label an owner-facing list shows. */
describe('readOnBehalf', () => {
  const files = { files: [], added: [], removed: [], changed: [] };
  const REC = {
    platformUpdateId: 'apu_01JABCDEFGHJKMNPQRSTVWXYZ0',
    staffUserId: 8001,
    staffUsername: 'mod-ana',
    ownerUserId: 7101,
    ownerUsername: 'owner-olga',
  };

  it('reads a recorded staff submit', () => {
    expect(readOnBehalf({ ...files, onBehalf: REC })).toEqual(REC);
  });

  it.each<[string, unknown]>([
    ['no summary', null],
    ['an ordinary submit', files],
    ['a non-object record', { ...files, onBehalf: 'yes' }],
    ['no update id', { ...files, onBehalf: { ...REC, platformUpdateId: '' } }],
    ['no owner', { ...files, onBehalf: { ...REC, ownerUserId: '7101' } }],
  ])('is null for %s', (_case, summary) => {
    expect(readOnBehalf(summary)).toBeNull();
    expect(staffSubmissionOf(summary)).toBeNull();
  });

  it('hasOnBehalfRecord: any onBehalf object counts, even one readOnBehalf cannot parse', () => {
    expect(hasOnBehalfRecord({ ...files, onBehalf: REC })).toBe(true);
    expect(hasOnBehalfRecord({ ...files, onBehalf: { ownerUserId: '7101' } })).toBe(true);
    expect(readOnBehalf({ ...files, onBehalf: { ownerUserId: '7101' } })).toBeNull();
    for (const summary of [null, files, { ...files, onBehalf: 'yes' }, { onBehalf: null }])
      expect(hasOnBehalfRecord(summary)).toBe(false);
  });

  it('labels a staff submission, naming the staff member or the team', () => {
    const s = staffSubmissionOf({ ...files, onBehalf: REC })!;
    expect(s).toEqual({ staffUsername: 'mod-ana', platformUpdateId: REC.platformUpdateId });
    expect(staffSubmissionLabel(s)).toBe('Staff submission by mod-ana (platform update)');
    expect(staffSubmissionLabel({ ...s, staffUsername: null })).toBe(
      'Staff submission by Civitai staff (platform update)'
    );
  });
});
