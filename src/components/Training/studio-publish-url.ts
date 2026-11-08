/** The publish entry the embedded Training Studio links to: the same query the studio's own shell
 *  builds (apps/training-studio/src/lib/publish-url-core.ts). */
export function studioPublishUrl({
  workflowId,
  epoch,
  ownRights,
  shareDataset,
}: {
  workflowId: string;
  epoch: number;
  ownRights?: boolean;
  shareDataset?: boolean;
}): string {
  return `/models/train/from-orchestrator?${new URLSearchParams({
    workflowId,
    epoch: String(epoch),
    ownRights: ownRights ? '1' : '0',
    shareDataset: ownRights && shareDataset ? '1' : '0',
  })}`;
}
