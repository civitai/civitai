// The query of the main app's publish entry (`/models/train/from-orchestrator`). The embedded host
// (src/components/Training/studio-publish-url.ts) builds the same one; a parity test in the main
// app holds the two together.
export const PUBLISH_PATH = '/models/train/from-orchestrator';

export type PublishQueryInput = {
  workflowId: string;
  epoch: number;
  ownRights?: boolean;
  shareDataset?: boolean;
};

export function publishSearchParams({
  workflowId,
  epoch,
  ownRights,
  shareDataset,
}: PublishQueryInput): URLSearchParams {
  const params = new URLSearchParams({ workflowId, epoch: String(epoch) });
  // No choice leaves the stored one as it is.
  if (ownRights === undefined && shareDataset === undefined) return params;
  params.set('ownRights', ownRights ? '1' : '0');
  params.set('shareDataset', ownRights && shareDataset ? '1' : '0');
  return params;
}

/** The choice a publish link carries: none until the owner touches a box, so reopening Publish
 *  keeps the stored choice instead of un-sharing it. */
export function publishShareChoice(
  touched: boolean,
  ownRights: boolean,
  shareDataset: boolean
): Pick<PublishQueryInput, 'ownRights' | 'shareDataset'> {
  return touched ? { ownRights, shareDataset: ownRights && shareDataset } : {};
}
