/**
 * What a dismissal should send to the account, if anything.
 *
 * Dependency-free on purpose: the signed-out guard is the thing most worth a test here, and
 * testing it inside the module that holds the tRPC client would mean mocking that client
 * wholesale. Signed out there is no account to write to and the device store is the whole
 * story, exactly as it was before this feature.
 */

/**
 * `window.isAuthed` is set by `CivitaiSessionProvider`, which is also what `~/utils/trpc` reads
 * to decide its cache-key. Read through here rather than inline so the property name is covered
 * by a test: misspell it and no dismissal is ever recorded, for anyone, silently.
 */
export function isSignedInBrowser() {
  return typeof window !== 'undefined' && !!window.isAuthed;
}
export function planDismissalRequests({
  ids,
  isAuthed,
  batchSize,
}: {
  ids: readonly number[];
  isAuthed: boolean;
  batchSize: number;
}): number[][] {
  if (!isAuthed) return [];

  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));

  return batches;
}
