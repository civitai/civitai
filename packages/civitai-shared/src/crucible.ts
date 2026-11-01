/** A scheduled crucible stays Pending until the activation job runs, which can lag its start. */
export const hasCrucibleStarted = (
  { status, startAt }: { status: string; startAt: Date | string | null },
  now = new Date()
) => status !== 'Pending' || (!!startAt && new Date(startAt) <= now);
