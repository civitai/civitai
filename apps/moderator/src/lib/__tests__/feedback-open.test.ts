import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_OPEN_PARAM,
  feedbackOpenHref,
  feedbackReportHref,
} from '$lib/feedback-open';

const at = (search: string) => new URL(`https://mod.example.test/feedback${search}`);

describe('feedbackOpenHref', () => {
  /**
   * The filters, the sort and the keyset page describe the QUEUE, which is the same queue before and
   * after a row is opened. Losing any of them on a click whose only job is to expand a row throws
   * the operator back to the default view mid-triage.
   */
  it('keeps every other param', () => {
    const url = new URL(
      feedbackOpenHref(at('?status=new&area=site-bug-report&cursor=99&sort=handled&dir=asc'), 4),
      'https://mod.example.test'
    );

    expect(url.pathname).toBe('/feedback');
    expect(url.searchParams.get(FEEDBACK_OPEN_PARAM)).toBe('4');
    expect(url.searchParams.get('status')).toBe('new');
    expect(url.searchParams.get('area')).toBe('site-bug-report');
    expect(url.searchParams.get('cursor')).toBe('99');
    expect(url.searchParams.get('sort')).toBe('handled');
  });

  it('replaces the open row rather than appending a second one', () => {
    const url = new URL(feedbackOpenHref(at('?open=7'), 9), 'https://mod.example.test');
    expect(url.searchParams.getAll(FEEDBACK_OPEN_PARAM)).toEqual(['9']);
  });

  it('closes the row on null', () => {
    expect(feedbackOpenHref(at('?open=7'), null)).toBe('/feedback');
    expect(feedbackOpenHref(at('?status=new&open=7'), null)).toBe('/feedback?status=new');
  });

  it('returns a same-origin path, never an absolute URL', () => {
    expect(feedbackOpenHref(at('?status=new'), 9)).toBe('/feedback?status=new&open=9');
  });

  /**
   * ⚠️ A STALE `?tab=` IS CARRIED, AND THAT IS THE POINT OF THE CASE. The panel was a tab strip once
   * and this helper's job was deleting the param, because the tab outlived the row it was chosen
   * for. There are no tabs now, so the param is read by nothing — and a helper that still deleted it
   * would be a mechanism with no live reason, which is how a future reader concludes the sticky-tab
   * bug is still being guarded against.
   */
  it('leaves a param from the retired tab strip alone rather than pretending to guard it', () => {
    const url = new URL(feedbackOpenHref(at('?tab=triage&open=7'), 9), 'https://mod.example.test');
    expect(url.searchParams.get('open')).toBe('9');
    expect(url.searchParams.get('tab')).toBe('triage');
  });
});

describe('feedbackReportHref', () => {
  /**
   * 🔴 IT CARRIES NO QUERY STRING, AND THAT IS THE WHOLE DIFFERENCE FROM `feedbackOpenHref`. This is
   * the link that leaves the queue — a sibling report, a message, a ticket — and anything resolved
   * against the current filters dead-ends for the reader who opens it with different ones.
   */
  it('is the id alone, with nothing from the current view on it', () => {
    expect(feedbackReportHref(12)).toBe('/feedback/12');
    expect(new URL(feedbackReportHref(12), 'https://mod.example.test').search).toBe('');
  });
});
