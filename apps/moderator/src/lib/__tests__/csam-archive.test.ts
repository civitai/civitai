import { describe, expect, it } from 'vitest';
import { archiveState, worstArchiveState } from '../csam-archive';

const now = new Date('2026-11-05T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const sent = { id: 7, reportSentAt: '2026-11-01T00:00:00Z', archivedAt: null };

describe('archiveState', () => {
  it('is archived once archivedAt is set, whatever the queue still holds', () => {
    const job = { reportIds: [7], claimedAt: minutesAgo(5), lastError: 'VerifyFailed' };
    expect(archiveState({ ...sent, archivedAt: '2026-11-02T00:00:00Z' }, job, now)).toBe(
      'archived'
    );
  });

  it('is archiving while a claim is younger than the TTL, even on a retry after a failure', () => {
    const job = {
      reportIds: [7],
      claimedAt: minutesAgo(30),
      attempts: 2,
      lastError: 'VerifyFailed',
    };
    expect(archiveState(sent, job, now)).toBe('archiving');
  });

  it('is failed when the last run left an error and nothing holds the claim', () => {
    expect(
      archiveState(sent, { reportIds: [7], attempts: 1, lastError: 'VerifyFailed' }, now)
    ).toBe('failed');
  });

  it('treats a claim past the TTL as abandoned, not in progress', () => {
    expect(archiveState(sent, { reportIds: [7], claimedAt: minutesAgo(361) }, now)).toBe('queued');
    expect(
      archiveState(sent, { reportIds: [7], claimedAt: minutesAgo(361), lastError: 'Error' }, now)
    ).toBe('failed');
  });

  it("ignores the user's queue row when it does not list this report", () => {
    expect(archiveState(sent, { reportIds: [8], claimedAt: minutesAgo(5) }, now)).toBe(
      'not-archived'
    );
    expect(archiveState({ ...sent, reportSentAt: null }, null, now)).toBe('unsent');
  });
});

describe('worstArchiveState', () => {
  it('shows the report that most needs a look', () => {
    expect(worstArchiveState(['archived', 'failed', 'queued'])).toBe('failed');
    expect(worstArchiveState(['archived', 'archiving'])).toBe('archiving');
    expect(worstArchiveState([])).toBeNull();
  });
});
