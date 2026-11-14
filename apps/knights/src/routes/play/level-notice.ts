/** The level or milestone card the player closed with "Onward", while the server records it, and the one whose
 * dismissal was refused. */
export type NoticeState = { closed: string | null; failed: string | null };

/** One key per standing shown, so closing one card never hides a later one. */
export const noticeKey = (notice: { rank: string; level: number }) =>
  `${notice.rank}:${notice.level}`;

/** "Onward": gone at once; the dismissal is recorded in the background. */
export function closeNotice(state: NoticeState, key: string) {
  state.closed = key;
}

/** The dismissal's answer. A refused or lost one brings the card back, with its error, for the player to press again. */
export function settleNotice(state: NoticeState, key: string, stored: boolean) {
  state.failed = stored ? null : key;
  if (!stored && state.closed === key) state.closed = null;
}

/** Runs whenever the load sends another notice or none; the same standing reached again later gets its card again. */
export function syncNotice(state: NoticeState, key: string | null) {
  if (state.closed !== key) state.closed = null;
  if (state.failed !== key) state.failed = null;
}

/** The one answer to "is the level card up". */
export const noticeShowing = (key: string | null, state: NoticeState) =>
  key !== null && state.closed !== key;

/** The refused dismissal's error belongs to its own card; the action's `form` outlives it, as votes post outside it. */
export const dismissFailedOn = (state: NoticeState, key: string | null) =>
  key !== null && state.failed === key;

export { DISMISS_FAILED } from '$lib/notice-copy';
