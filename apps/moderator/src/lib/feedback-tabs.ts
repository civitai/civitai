import { urlWith } from './url';

/**
 * The detail panel's tabs.
 *
 * Order is the triage order: read the complaint AND what they sent with it, see where they were,
 * act, then link it to an issue.
 *
 * 🔴 THERE IS NO `attachments` TAB, AND THAT IS A DECISION, NOT AN OMISSION. Message + attachment is
 * the core triage pairing — "this looked wrong" plus the picture of it — so they render TOGETHER on
 * the default tab, at a cost of zero navigations. An earlier revision of this panel gave attachments
 * their own tab; that cost two navigations to see a pairing that previously cost none, and the
 * containment it bought was marginal because thumbnails already load only once a ROW is expanded.
 * `?tab=attachments` degrades to the default via `feedbackTabFromUrl`, which is exactly where the
 * attachments now are, so an old shared link still lands on them.
 */
export const FEEDBACK_TABS = [
  { id: 'message', label: 'Message' },
  { id: 'context', label: 'Context' },
  { id: 'triage', label: 'Triage' },
  { id: 'issue', label: 'Issue' },
] as const;

export type FeedbackTab = (typeof FEEDBACK_TABS)[number]['id'];

/** The complaint and its attachments — the only thing that is always worth reading first. */
export const DEFAULT_FEEDBACK_TAB: FeedbackTab = 'message';

export const FEEDBACK_TAB_PARAM = 'tab';

export const isFeedbackTab = (value: unknown): value is FeedbackTab =>
  typeof value === 'string' && FEEDBACK_TABS.some((t) => t.id === value);

export const feedbackTabLabel = (tab: FeedbackTab): string =>
  FEEDBACK_TABS.find((t) => t.id === tab)!.label;

/**
 * Which tab owns a given form's refusal.
 *
 * 🔴 The panel does NOT rely on this to make a refusal visible — a refusal renders above the tab
 * strip, unconditionally (see `FeedbackDetail.svelte`). This only NAMES the tab in that banner, so
 * the operator is told where to go rather than left to hunt.
 */
export const FEEDBACK_FORM_TAB = { triage: 'triage', promote: 'issue' } as const satisfies Record<
  string,
  FeedbackTab
>;

/**
 * 🔴 The tab lives in the URL because every successful write calls `invalidateAll()`. Component-local
 * state would be re-created by that reload and snap the operator back to `Message` the instant their
 * save landed — on the exact tab they were working in.
 *
 * An unknown or absent value degrades to the default, the same contract every other param on this
 * page has: `?tab=` is user-controllable and must never 500 a queue nobody can then open.
 */
export function feedbackTabFromUrl(url: URL): FeedbackTab {
  const raw = url.searchParams.get(FEEDBACK_TAB_PARAM);
  return isFeedbackTab(raw) ? raw : DEFAULT_FEEDBACK_TAB;
}

/**
 * The `href` a tab trigger carries.
 *
 * 🔴 A REAL `href`, not a JS-only button, and the default tab DELETES the param rather than spelling
 * it. Two separate reasons:
 *   - Without JS the tab triggers must still work, because the no-JS surface on this page is
 *     deliberate: a full navigation to `?tab=triage` re-runs `load` and server-renders the triage
 *     form. A `<button onclick>` would leave the form unreachable for a client that never ran the
 *     handler, and unreachable is worse than unstyled.
 *   - `urlWith` deletes on `null`, so a row opened at its default tab produces the same URL it does
 *     today. A shared link is unchanged unless the sharer actually moved off `Message`.
 */
export function feedbackTabHref(url: URL, tab: FeedbackTab): string {
  return urlWith(url, { [FEEDBACK_TAB_PARAM]: tab === DEFAULT_FEEDBACK_TAB ? null : tab });
}
