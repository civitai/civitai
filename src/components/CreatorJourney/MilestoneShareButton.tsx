import { Anchor, Popover, Text, UnstyledButton } from '@mantine/core';
import { IconEyeOff, IconShare3 } from '@tabler/icons-react';
import { openUserProfileEditModal } from '~/components/Dialog/triggers/user-profile-edit';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import {
  milestoneShareHref,
  milestoneShareToken,
  scoreTierSlugFromKey,
  SPECIAL_SHARE_TITLE,
} from '~/shared/constants/creator-journey.constants';

/** Only offered for a milestone whose share card renders: anything else would preview the bare profile. */
export function MilestoneShareButton({
  username,
  milestoneKey,
  name,
  secret,
}: {
  username: string;
  milestoneKey: string;
  name: string;
  /** From the owner's share states. Required, so no caller can leave a secret's name in the text. */
  secret: boolean;
}) {
  const verb = scoreTierSlugFromKey(milestoneKey) ? 'reached' : 'earned';
  return (
    <ShareButton
      url={milestoneShareHref(username, milestoneShareToken(milestoneKey))}
      title={secret ? SPECIAL_SHARE_TITLE : `I ${verb} ${name} on Civitai`}
    >
      <LegacyActionIcon radius="xl" aria-label={`Share ${name}`}>
        <IconShare3 size={16} />
      </LegacyActionIcon>
    </ShareButton>
  );
}

export const UNHIDE_TO_SHARE = 'This badge is hidden on your profile.';

/**
 * Where the share button would sit on a badge the owner hid from their profile: a hidden badge's card
 * does not render, so its share button never appears, which read as share being broken. A popover,
 * not a tooltip, so a tap on a phone opens it.
 */
export function UnhideToShareHint({ name }: { name: string }) {
  return (
    <Popover width={220} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <UnstyledButton
          aria-label={`${name} is hidden on your profile`}
          className="flex h-7 items-center gap-1 rounded-full border border-dashed border-gray-4 bg-white px-2 text-xs font-semibold text-gray-6 dark:border-dark-3 dark:bg-dark-6 dark:text-dark-2"
        >
          <IconEyeOff size={14} />
          Hidden
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown>
        <Text size="xs">
          {UNHIDE_TO_SHARE}{' '}
          <Anchor component="button" size="xs" onClick={() => openUserProfileEditModal()}>
            Unhide it
          </Anchor>{' '}
          to share.
        </Text>
      </Popover.Dropdown>
    </Popover>
  );
}
