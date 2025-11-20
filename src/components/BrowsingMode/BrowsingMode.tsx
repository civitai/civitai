import {
  Group,
  Text,
  Stack,
  Popover,
  Checkbox,
  Button,
  Tooltip,
  Anchor,
  Indicator,
} from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { IconProps } from '@tabler/icons-react';
import { IconAlertTriangle, IconEyeExclamation, IconSword } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { BrowsingLevelsGrouped } from '~/components/BrowsingLevel/BrowsingLevelsGrouped';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
// import { constants } from '~/server/common/constants';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useIsRegionRestricted } from '~/hooks/useIsRegionRestricted';
import { dialogStore } from '~/components/Dialog/dialogStore';

const HiddenTagsModal = dynamic(() => import('~/components/Tags/HiddenTagsModal'), { ssr: false });

export function BrowsingModeIcon({ iconProps = {} }: BrowsingModeIconProps) {
  const { isRestricted } = useIsRegionRestricted();

  return (
    <Popover zIndex={301 + 1} withArrow withinPortal>
      <Popover.Target>
        <Indicator className="flex items-center" color="red" disabled={!isRestricted}>
          <LegacyActionIcon variant="subtle" color="gray">
            <IconEyeExclamation {...iconProps} />
          </LegacyActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown p="md" style={{ zIndex: 'calc(var(--dialog-z-index) + 2)' }}>
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
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const features = useFeatureFlags();
  const { isRestricted } = useIsRegionRestricted();

  const toggleBlurNsfw = () => setState((state) => ({ blurNsfw: !state.blurNsfw }));
  const toggleDisableHidden = () => setState((state) => ({ disableHidden: !state.disableHidden }));

  return (
    <div id="browsing-mode">
      <Stack gap="md" className="sm:min-w-96">
        {showNsfw && (
          <Stack gap="lg">
            <Stack gap={4}>
              <Stack gap={0}>
                <Group align="flex-start">
                  <Text style={{ lineHeight: 1 }}>Browsing Level</Text>
                  {showNsfw && features.newOrderGame && (
                    <Tooltip label="Help us improve by playing!" withArrow color="dark">
                      <Button
                        onClick={closeMenu}
                        component={Link}
                        href="/games/knights-of-new-order"
                        size="compact-xs"
                        ml="auto"
                        variant="outline"
                        color="orange.5"
                      >
                        <Group gap={4}>
                          Join the Knights Order
                          <IconSword size={14} />
                        </Group>
                      </Button>
                    </Tooltip>
                  )}
                </Group>
                <Text c="dimmed">Select the levels of content you want to see</Text>
              </Stack>
              <BrowsingLevelsGrouped />
              {isRestricted && (
                <Text c="red" size="xs" inline>
                  Your content levels are limited by restrictions in your region
                </Text>
              )}
              {browsingSettingsAddons.settings.disablePoi && (
                <Group gap="sm" mt={4}>
                  <IconAlertTriangle size={16} />
                  <Text c="dimmed" size="xs">
                    With X or XXX enabled, some content may be hidden.{' '}
                    <Anchor href="/articles/13632">Learn more</Anchor>
                  </Text>
                </Group>
              )}
            </Stack>
            <Checkbox
              checked={blurNsfw}
              onChange={toggleBlurNsfw}
              label="Blur mature content (R+)"
              size="md"
            />
          </Stack>
        )}

        <Group justify="space-between">
          <Checkbox
            checked={!disableHidden}
            onChange={toggleDisableHidden}
            label={
              <Text>
                Apply{' '}
                <Anchor
                  onClick={(e: React.MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dialogStore.trigger({ component: HiddenTagsModal, target: '#browsing-mode' });
                  }}
                  span
                >
                  my filters
                </Anchor>
              </Text>
            }
            size="md"
          />
        </Group>
      </Stack>
    </div>
  );
}
