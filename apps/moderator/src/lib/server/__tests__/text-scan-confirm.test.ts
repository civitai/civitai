import { describe, expect, it, vi } from 'vitest';
import { CONFIRM_ABOVE } from '$lib/text-scan-lab/limits';
import { confirmRequest, confirmStamp } from '../text-scan-lab/confirm';

const form = (confirmed?: string) => {
  const f = new FormData();
  if (confirmed !== undefined) f.set('confirmed', confirmed);
  return f;
};
const run = (count: number) => ({ count, skipped: 1, stamp: confirmStamp(count) });

describe('confirmRequest', () => {
  it(`lets ${CONFIRM_ABOVE} cases through without asking`, async () => {
    const estimate = vi.fn(async () => 2);
    expect(await confirmRequest(form(), run(CONFIRM_ABOVE), estimate)).toBeNull();
    expect(estimate).not.toHaveBeenCalled();
  });

  it('asks about a larger run that was not confirmed, with its time estimate', async () => {
    expect(await confirmRequest(form(), run(11), async () => 90)).toEqual({
      needsConfirm: true,
      count: 11,
      skipped: 1,
      stamp: '11:',
      seconds: 90,
      changed: false,
    });
  });

  it('runs once confirmed with the matching stamp', async () => {
    expect(await confirmRequest(form('11:'), run(11), async () => 1)).toBeNull();
  });

  it('asks again, flagged as changed, when the confirmed stamp no longer matches', async () => {
    expect(await confirmRequest(form('11:'), run(12), async () => 1)).toMatchObject({
      needsConfirm: true,
      count: 12,
      changed: true,
    });
  });

  it("stamps the draft's version", () => {
    expect(confirmStamp(3, new Date('2026-10-06T00:00:00Z'))).toBe('3:2026-10-06T00:00:00.000Z');
  });
});
