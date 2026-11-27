// What the two "What's new" dialogs share in the browser: the storage they remember a dismissal in, and the send that
// records it on the server without holding the dialog open.

export type SeenStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Records the dismissal in the background and re-reads the page once it is stored; a failure waits for the next load. */
export function sendInBackground(deps: { send: () => Promise<boolean>; refresh: () => unknown }) {
  void deps
    .send()
    .then((stored) => (stored ? deps.refresh() : undefined))
    .catch(() => undefined);
}
