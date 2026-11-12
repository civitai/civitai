import { Button } from '@mantine/core';
import { IconLayoutGrid } from '@tabler/icons-react';
import { openVersionShowcaseEditor } from '~/components/Dialog/triggers/version-showcase-editor';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/** "Edit showcase" for the model's creator and moderators. Renders nothing for anyone else. */
export function VersionShowcaseEditButton({
  modelVersionId,
  modelUserId,
}: {
  modelVersionId: number;
  modelUserId: number;
}) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const canEdit = currentUser && (currentUser.id === modelUserId || currentUser.isModerator);
  if (!features.modelVersionShowcase || !canEdit) return null;
  return (
    <Button
      size="compact-xs"
      variant="subtle"
      leftSection={<IconLayoutGrid size={14} />}
      className="self-end"
      onClick={() => openVersionShowcaseEditor({ modelVersionId })}
    >
      Edit showcase
    </Button>
  );
}
