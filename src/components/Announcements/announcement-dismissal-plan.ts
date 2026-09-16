/**
 * What a dismissal should send to the account, if anything.
 *
 * Pure and dependency-free on purpose: the signed-out guard is the thing most worth a test
 * here, and testing it inside the module that holds the tRPC client would mean mocking that
 * client wholesale. Signed out there is no account to write to and the device store is the
 * whole story, exactly as it was before this feature.
 */
export function planDismissalRequests({
  ids,
  isAuthed,
  batchSize,
}: {
  ids: readonly number[];
  isAuthed: boolean;
  batchSize: number;
}): number[][] {
  if (!isAuthed || !ids.length) return [];

  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));

  return batches;
}
