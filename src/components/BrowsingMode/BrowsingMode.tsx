import {
  Divider,
  Group,
  SegmentedControl,
  Text,
  Stack,
  Switch,
  Popover,
  ActionIcon,
  Indicator,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconEye, IconEyeOff, TablerIconProps } from '@tabler/icons';
import { useEffect } from 'react';
import { BlurToggle } from '~/components/Settings/BlurToggle';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { invalidateModeratedContentDebounced } from '~/utils/query-invalidation-utils';
import { trpc } from '~/utils/trpc';

const options = [
  { label: 'Safe', value: BrowsingMode.SFW },
  { label: 'My Filters', value: BrowsingMode.NSFW },
  { label: 'Everything', value: BrowsingMode.All },
];

export function BrowsingModeIcon({ iconProps = {} }: BrowsingModeIconProps) {
  const currentUser = useCurrentUser();
  const cookieMode = useFiltersContext((state) => state.browsingMode);

  const [browsingMode] = useLocalStorage({ key: 'browsing-mode', defaultValue: cookieMode });

  if (!currentUser || !browsingMode) return null;

  const indicatorColor = {
    [BrowsingMode.SFW]: 'blue',
    [BrowsingMode.NSFW]: undefined,
    [BrowsingMode.All]: 'red',
  }[browsingMode];

  return (
    <Popover withArrow>
      <Popover.Target>
        <Indicator color={indicatorColor} disabled={!indicatorColor}>
          <ActionIcon>
            {currentUser.blurNsfw ? <IconEyeOff {...iconProps} /> : <IconEye {...iconProps} />}
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <BrowsingModeMenu />
      </Popover.Dropdown>
    </Popover>
  );
}
type BrowsingModeIconProps = {
  iconProps?: TablerIconProps;
};

export function BrowsingModeMenu() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();
  const cookieMode = useFiltersContext((state) => state.browsingMode);
  const setFilters = useFiltersContext((state) => state.setFilters);
  const setBrowsingMode = (mode: BrowsingMode) => {
    setFilters({ browsingMode: mode });
    invalidateModeratedContentDebounced(queryUtils);
    setMode(mode);
  };
  const isMobile = useIsMobile();
  const [browsingMode, setMode] = useLocalStorage({
    key: 'browsing-mode',
    defaultValue: cookieMode,
  });

  useEffect(() => {
    if (!browsingMode)
      setBrowsingMode(currentUser?.showNsfw ? BrowsingMode.NSFW : BrowsingMode.SFW);
  }, [browsingMode, setBrowsingMode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!currentUser || !browsingMode) return null;

  const browsingModeColor = {
    [BrowsingMode.SFW]: 'blue',
    [BrowsingMode.NSFW]: 'gray',
    [BrowsingMode.All]: 'red',
  }[browsingMode];
  const showBrowsingMode = currentUser.showNsfw;
  const showBlurToggle = !isMobile && showBrowsingMode && browsingMode !== BrowsingMode.SFW;
  return (
    <Stack spacing={4}>
      {showBrowsingMode && (
        <>
          <Divider label="Browsing Mode" labelProps={{ weight: 'bold' }} mb={-4} />
          <SegmentedControl
            data={options}
            value={browsingMode}
            onChange={setBrowsingMode}
            my={5}
            size={isMobile ? 'sm' : 'xs'}
            color={browsingModeColor}
            styles={(theme) => ({
              root: {
                border: `1px solid ${
                  theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
                }`,
                background: 'none',
              },
            })}
          />
        </>
      )}
      {showBlurToggle && (
        <BlurToggle iconProps={{ size: 20 }}>
          {({ icon, toggle, blurred }) => (
            <Group spacing={10}>
              <Text size="xs" weight={500}>
                Blur Mature Content
              </Text>
              <Switch ml="auto" checked={blurred} onChange={toggle} />
            </Group>
          )}
        </BlurToggle>
      )}
    </Stack>
  );
}
