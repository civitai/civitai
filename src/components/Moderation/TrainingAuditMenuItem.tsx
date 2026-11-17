import { ModeratorLookupMenuItem } from '~/components/Moderation/ModeratorLookupMenuItem';
import { moderatorTrainingAuditPath } from '~/shared/constants/moderator-app';
import { ModelUploadType } from '~/shared/utils/prisma/enums';

export function TrainingAuditMenuItem({
  modelId,
  uploadType,
  isModerator,
}: {
  modelId: number;
  uploadType: ModelUploadType;
  isModerator: boolean;
}) {
  if (!isModerator || uploadType !== ModelUploadType.Trained) return null;
  return (
    <ModeratorLookupMenuItem path={moderatorTrainingAuditPath(modelId)}>
      Training audit
    </ModeratorLookupMenuItem>
  );
}
