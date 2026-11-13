export type SeenStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type DismissDeps = {
  userId: number | null;
  /** May throw: some browsers refuse `localStorage` itself, not only its methods. */
  storage: () => SeenStorage;
  /** Records the dismissal on the server; true once it is stored. */
  send: () => Promise<boolean>;
  /** Re-reads the page, which holds the rating guide back until the server has the dismissal. */
  refresh: () => unknown;
};

/** `checked` stays false until the stored marker has been read, which only the browser can do. */
export type DismissState = { hidden: boolean; checked: boolean };

const seenKey = (userId: number) => `knights:whats-new-seen:${userId}`;

function readSeen({ userId, storage }: DismissDeps): boolean {
  if (userId === null) return false;
  try {
    return storage().getItem(seenKey(userId)) === '1';
  } catch {
    return false;
  }
}

function writeSeen({ userId, storage }: DismissDeps) {
  if (userId === null) return;
  try {
    storage().setItem(seenKey(userId), '1');
  } catch {
    // Without storage the server's flag is the only record; the next load shows the dialog if the send failed.
  }
}

function sendInBackground(deps: DismissDeps) {
  void deps
    .send()
    .then((stored) => (stored ? deps.refresh() : undefined))
    .catch(() => undefined);
}

/** Got it, Escape and the backdrop: closed at once, remembered in the browser, recorded on the server in the background. */
export function closeWhatsNew(state: DismissState, deps: DismissDeps) {
  state.hidden = true;
  writeSeen(deps);
  sendInBackground(deps);
}

/** Runs whenever the load starts or stops sending the copy. A copy the browser already dismissed is sent again, not shown. */
export function syncWhatsNew(state: DismissState, sent: boolean, deps: DismissDeps) {
  if (!sent) {
    state.hidden = false;
  } else if (readSeen(deps)) {
    state.hidden = true;
    sendInBackground(deps);
  }
  state.checked = true;
}

/** The one answer to "is the What's new dialog up": the layout renders by it and /play blocks its keys by it. */
export const whatsNewShowing = (sent: boolean, state: DismissState) =>
  sent && state.checked && !state.hidden;
