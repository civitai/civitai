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
  return new URLSearchParams({
    workflowId,
    epoch: String(epoch),
    ownRights: ownRights ? '1' : '0',
    shareDataset: ownRights && shareDataset ? '1' : '0',
  });
}
