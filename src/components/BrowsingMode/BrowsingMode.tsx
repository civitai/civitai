import { Group, Text, Stack, Popover, ActionIcon, Checkbox, Button, Tooltip } from '@mantine/core';
import { NextLink } from '@mantine/next';
import {
  IconCaretRightFilled,
  IconDeviceGamepad,
  IconEyeCog,
  IconSettings,
  IconProps,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useBrowsingModeContext } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BrowsingLevelsGrouped } from '~/components/BrowsingLevel/BrowsingLevelsGrouped';
import { openHiddenTagsModal } from '~/components/Dialog/dialog-registry';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';

export function BrowsingModeIcon({ iconProps = {} }: BrowsingModeIconProps) {
  const currentUser = useCurrentUser();
  if (!currentUser) return null;
  return (
    <Popover zIndex={constants.imageGeneration.drawerZIndex + 1} withArrow withinPortal>
      <Popover.Target>
        <ActionIcon>
          <IconEyeCog {...iconProps} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown p="md">
        <BrowsingModeMenu />
      </Popover.Dropdown>
    </Popover>
  );
}
type BrowsingModeIconProps = {
  iconProps?: IconProps;
  closeMenu?: () => void;
};

export function BrowsingModeMenu({ closeMenu }: { closeMenu?: () => void }) {
  const { toggleBlurNsfw, toggleDisableHidden, useStore } = useBrowsingModeContext();
  const { blurNsfw } = useStore((state) => state);
  const currentUser = useCurrentUser();
  const showNsfw = currentUser?.showNsfw;
  // const blurNsfw = currentUser?.blurNsfw;
  const disableHidden = currentUser?.disableHidden;

  return (
    <div id="browsing-mode">
      <Stack spacing="md" className="sm:min-w-96">
        <Group align="flex-start" spacing={8} position="apart" noWrap>
          <Text weight={500} sx={{ lineHeight: 1 }}>
            Content Controls
          </Text>
          <Group spacing={4} noWrap>
            {/* {showNsfw && (
              <Tooltip label="Help us improve by playing!" withArrow color="dark">
                <Button
                  onClick={closeMenu}
                  component={NextLink}
                  href="/research/rater"
                  compact
                  size="xs"
                  ml="auto"
                  variant="outline"
                >
                  <Group spacing={4}>
                    Rating Game
                    <IconCaretRightFilled size={14} />
                  </Group>
                </Button>
              </Tooltip>
            )} */}
            <Link href="/user/account#content-controls">
              <ActionIcon size="sm" radius="sm" variant="subtle">
                <IconSettings />
              </ActionIcon>
            </Link>
          </Group>
        </Group>
        {showNsfw && (
          <Checkbox
            checked={blurNsfw}
            onChange={(e) => toggleBlurNsfw(e.target.checked)}
            label="Blur mature content"
            size="md"
          />
        )}

        <Group position="apart">
          <Checkbox
            checked={!disableHidden}
            onChange={(e) => toggleDisableHidden(!e.target.checked)}
            label={
              <Text>
                Apply{' '}
                <Text
                  component="span"
                  variant="link"
                  underline
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openHiddenTagsModal();
                  }}
                >
                  my filters
                </Text>
              </Text>
            }
            size="md"
          />
        </Group>
      </Stack>
    </div>
  );
}
