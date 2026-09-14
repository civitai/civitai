import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEEDBACK_TAB,
  FEEDBACK_FORM_TAB,
  FEEDBACK_TABS,
  FEEDBACK_TAB_PARAM,
  feedbackTabFromUrl,
  feedbackTabHref,
  feedbackTabLabel,
  isFeedbackTab,
  type FeedbackTab,
} from '$lib/feedback-tabs';

const at = (search: string) => new URL(`https://mod.example.test/feedback${search}`);

describe('the tab ledger', () => {
  /**
   * Hand-typed against the constant. Not decoration: the panel's `{#if activeTab === …}` chain has a
   * branch per id, so adding an id without a branch renders an EMPTY panel — a tab that opens onto
   * nothing, with no error anywhere. This fails on an add or a removal and makes the author look.
   */
  it('is exactly these tabs, in this order', () => {
    expect(FEEDBACK_TABS.map((t) => t.id)).toEqual(['message', 'context', 'triage', 'issue']);
    expect(FEEDBACK_TABS.map((t) => t.label)).toEqual(['Message', 'Context', 'Triage', 'Issue']);
  });

  /**
   * 🔴 THERE IS NO `attachments` TAB. Attachments render WITH the message on the default tab, because
   * "this looked wrong" plus the picture of it is one triage claim and splitting it cost two
   * navigations for a pairing that previously cost none. Pinned here so a future edit that re-adds
   * the tab has to come back and read the reason rather than discovering it from a screenshot.
   */
  it('has no attachments tab', () => {
    expect(FEEDBACK_TABS.map((t) => t.id)).not.toContain('attachments');
    expect(isFeedbackTab('attachments')).toBe(false);
  });

  it('opens on the complaint', () => {
    expect(DEFAULT_FEEDBACK_TAB).toBe('message');
  });

  it('labels every id', () => {
    for (const tab of FEEDBACK_TABS) expect(feedbackTabLabel(tab.id)).toBe(tab.label);
  });

  /**
   * 🔴 The refusal banner names the owning tab. A mapping that pointed at a tab the form is not on
   * would send the operator to the wrong panel to fix a save that was refused — worse than saying
   * nothing, because it reads as authoritative.
   */
  it('maps each form to the tab its controls actually live on', () => {
    expect(FEEDBACK_FORM_TAB.triage).toBe('triage');
    expect(FEEDBACK_FORM_TAB.promote).toBe('issue');
  });
});

describe('isFeedbackTab', () => {
  it('accepts every declared id and nothing else', () => {
    for (const tab of FEEDBACK_TABS) expect(isFeedbackTab(tab.id)).toBe(true);
    for (const bad of ['Message', 'promote', '', 'triage ', null, undefined, 7, {}])
      expect(isFeedbackTab(bad)).toBe(false);
  });
});

describe('feedbackTabFromUrl', () => {
  it('reads the selected tab', () => {
    expect(feedbackTabFromUrl(at('?open=12&tab=triage'))).toBe('triage');
    expect(feedbackTabFromUrl(at('?tab=context'))).toBe('context');
  });

  /**
   * A link shared while the attachments tab existed still opens onto the attachments — they are on
   * the default tab now, and an unknown `?tab=` degrades to the default. The value of this case is
   * that the degrade lands somewhere CORRECT, not merely somewhere safe.
   */
  it('lands an old ?tab=attachments link on the tab that now holds them', () => {
    expect(feedbackTabFromUrl(at('?tab=attachments&open=12'))).toBe('message');
  });

  /**
   * `?tab=` is user-controllable, like every other param this page reads. It degrades rather than
   * throwing, for the reason `querySchema` gives every field a `.catch()`: a bad value must not 500 a
   * queue nobody can then open.
   */
  it.each([
    ['absent', '?open=12'],
    ['empty', '?tab='],
    ['unknown', '?tab=nope'],
    ['a case mismatch', '?tab=Triage'],
    ['repeated, first value unknown', '?tab=nope&tab=triage'],
  ])('degrades to the default when the param is %s', (_label, search) => {
    expect(feedbackTabFromUrl(at(search))).toBe(DEFAULT_FEEDBACK_TAB);
  });
});

describe('feedbackTabHref', () => {
  it('sets the param and keeps everything else on the URL', () => {
    // `?open=` and `?cursor=` are the row and the keyset page; losing either on a tab click would
    // close the row the operator is reading.
    const href = feedbackTabHref(at('?status=new&open=12&cursor=99'), 'triage');
    const url = new URL(href, 'https://mod.example.test');

    expect(url.pathname).toBe('/feedback');
    expect(url.searchParams.get(FEEDBACK_TAB_PARAM)).toBe('triage');
    expect(url.searchParams.get('open')).toBe('12');
    expect(url.searchParams.get('cursor')).toBe('99');
    expect(url.searchParams.get('status')).toBe('new');
  });

  it('replaces a tab already on the URL rather than appending a second one', () => {
    const url = new URL(
      feedbackTabHref(at('?tab=context&open=12'), 'issue'),
      'https://mod.example.test'
    );
    expect(url.searchParams.getAll(FEEDBACK_TAB_PARAM)).toEqual(['issue']);
  });

  /**
   * The default tab DELETES the param. A row opened at `Message` therefore produces the URL it
   * produces today, so a link shared out of this queue is unchanged unless the sharer moved off it.
   */
  it('omits the param for the default tab', () => {
    expect(feedbackTabHref(at('?tab=triage&open=12'), DEFAULT_FEEDBACK_TAB)).toBe(
      '/feedback?open=12'
    );
    expect(feedbackTabHref(at('?open=12'), DEFAULT_FEEDBACK_TAB)).toBe('/feedback?open=12');
  });

  /** Every href must round-trip back through the reader, or the strip points at tabs it cannot open. */
  it.each(FEEDBACK_TABS.map((t) => [t.id] as [FeedbackTab]))(
    'round-trips %s through the URL',
    (tab) => {
      const href = feedbackTabHref(at('?status=new&open=12'), tab);
      expect(feedbackTabFromUrl(new URL(href, 'https://mod.example.test'))).toBe(tab);
    }
  );

  it('returns a same-origin path, never an absolute URL', () => {
    for (const tab of FEEDBACK_TABS) {
      expect(feedbackTabHref(at('?open=12'), tab.id).startsWith('/feedback')).toBe(true);
    }
  });
});
