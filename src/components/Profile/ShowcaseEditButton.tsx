import { ActionIcon } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { openDialog } from '~/components/Dialog/openDialog';
import { Tooltip } from '~/components/MantineOverlays';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { useCurrentUser } from '~/hooks/useCurrentUser';

/**
 * The owner's shortcut to a showcase section's editor, on their own profile. Hidden from everyone
 * else, and while the profile is muted, as Customize profile is.
 */
export function ShowcaseEditButton({
  user,
  sectionId,
}: ProfileSectionProps & { sectionId: string }) {
  const currentUser = useCurrentUser();
  if (!currentUser || currentUser.id !== user.id || user.muted) return null;

  return (
    <Tooltip label="Edit section">
      <ActionIcon
        variant="subtle"
        size="lg"
        radius="xl"
        aria-label="Edit section"
        onClick={() =>
          openDialog(() => import('~/components/Profile/ShowcaseSectionModal'), {
            sections: user.profile.showcaseSections ?? [],
            sectionId,
          })
        }
      >
        <IconPencil size={18} />
      </ActionIcon>
    </Tooltip>
  );
}
