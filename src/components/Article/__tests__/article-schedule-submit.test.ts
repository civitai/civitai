import { describe, expect, it } from 'vitest';
import { getArticleScheduleSubmit } from '~/components/Article/article-schedule-submit';

const stored = new Date('2026-10-20T16:00:00.000Z');
const values = { title: 't', scheduledAt: stored, publishedAt: null };

describe('getArticleScheduleSubmit', () => {
  it('never sends the stored schedule back on a plain save', () => {
    const submit = getArticleScheduleSubmit(values, {
      publishing: false,
      scheduleIntent: undefined,
    });

    expect(submit.rest).toEqual({ title: 't' });
    expect(submit.scheduledAt).toBeUndefined();
    expect(submit.publishNow).toBe(false);
  });

  it('sends the picked date when scheduling', () => {
    const picked = new Date('2026-11-01T09:00:00.000Z');
    expect(
      getArticleScheduleSubmit(values, { publishing: false, scheduleIntent: picked }).scheduledAt
    ).toBe(picked);
  });

  it('sends null to cancel', () => {
    expect(
      getArticleScheduleSubmit(values, { publishing: false, scheduleIntent: null }).scheduledAt
    ).toBeNull();
  });

  it('publishes on a Publish click', () => {
    expect(
      getArticleScheduleSubmit(values, { publishing: true, scheduleIntent: undefined }).publishNow
    ).toBe(true);
  });

  it('does not publish a schedule submit left over from an earlier Publish click', () => {
    for (const scheduleIntent of [new Date(), null])
      expect(
        getArticleScheduleSubmit(values, { publishing: true, scheduleIntent }).publishNow
      ).toBe(false);
  });
});
