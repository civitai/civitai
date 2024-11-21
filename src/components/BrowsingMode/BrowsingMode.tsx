import { Group, Text, Stack, Popover, ActionIcon, Checkbox, Button, Tooltip } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconCaretRightFilled, IconEyeExclamation, IconProps } from '@tabler/icons-react';
import { BrowsingLevelsGrouped } from '~/components/BrowsingLevel/BrowsingLevelsGrouped';
import { openHiddenTagsModal } from '~/components/Dialog/dialog-registry';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { constants } from '~/server/common/constants';

export function BrowsingModeIcon({ iconProps = {} }: BrowsingModeIconProps) {
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
  iconProps?: IconProps;
  closeMenu?: () => void;
};

export function BrowsingModeMenu({ closeMenu }: { closeMenu?: () => void }) {
  const showNsfw = useBrowsingSettings((x) => x.showNsfw);
  const blurNsfw = useBrowsingSettings((x) => x.blurNsfw);
  const disableHidden = useBrowsingSettings((x) => x.disableHidden);
  const setState = useBrowsingSettings((x) => x.setState);

  const toggleBlurNsfw = () => setState((state) => ({ blurNsfw: !state.blurNsfw }));
  const toggleDisableHidden = () => setState((state) => ({ disableHidden: !state.disableHidden }));

  return (
    <div id="browsing-mode">
      <Stack spacing="md" className="sm:min-w-96" py="xl">
        {showNsfw && (
          <Stack spacing="lg">
            <Stack spacing={4}>
              <Stack spacing={0}>
                <Group align="flex-start">
                  <Text sx={{ lineHeight: 1, marginBottom: 20 }}>Browsing Level</Text>
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
              onChange={toggleBlurNsfw}
              label="Blur mature content (R+)"
              size="md"
            />
          </Stack>
        )}

        <Group position="apart">
          <Checkbox
            checked={!disableHidden}
            onChange={toggleDisableHidden}
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
