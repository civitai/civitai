import { Group, Text, Stack, Popover, ActionIcon, Checkbox, Button, Tooltip } from '@mantine/core';
import { NextLink } from '@mantine/next';
import {
  IconCaretRightFilled,
  IconDeviceGamepad,
  IconEyeExclamation,
  TablerIconsProps,
} from '@tabler/icons-react';
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
          <IconEyeExclamation {...iconProps} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown p="md">
        <BrowsingModeMenu />
      </Popover.Dropdown>
    </Popover>
  );
}
type BrowsingModeIconProps = {
  iconProps?: TablerIconsProps;
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
        {showNsfw && (
          <Stack spacing="lg">
            <Stack spacing={4}>
              <Stack spacing={0}>
                <Group align="flex-start">
                  <Text sx={{ lineHeight: 1 }}>Browsing Level</Text>
                  {showNsfw && (
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
                  )}
                </Group>
                <Text color="dimmed">Select the levels of content you want to see</Text>
              </Stack>
              <BrowsingLevelsGrouped />
            </Stack>
            <Checkbox
              checked={blurNsfw}
              onChange={(e) => toggleBlurNsfw(e.target.checked)}
              label="Blur mature content (R+)"
              size="md"
            />
          </Stack>
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
