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
import {
  IconEye,
  IconEyeOff,
  IconShield,
  IconShieldOff,
  TablerIconsProps,
} from '@tabler/icons-react';
import { BrowsingLevelsGrouped } from '~/components/BrowsingLevel/BrowsingLevelsGrouped';
import { BlurToggle } from '~/components/Settings/BlurToggle';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { constants } from '~/server/common/constants';
import { BrowsingMode } from '~/server/common/enums';
import { invalidateModeratedContentDebounced } from '~/utils/query-invalidation-utils';
import { trpc } from '~/utils/trpc';

const options = [
  { label: 'Safe', value: BrowsingMode.SFW },
  { label: 'My Filters', value: BrowsingMode.NSFW },
  { label: 'Everything', value: BrowsingMode.All },
];

const indicatorProps: TablerIconsProps = { size: 12, strokeWidth: 4 };

export function BrowsingModeIcon({ iconProps = {} }: BrowsingModeIconProps) {
  const currentUser = useCurrentUser();
  const browsingMode = useFiltersContext((state) => state.browsingMode);

  if (!currentUser || !browsingMode) return null;

  const indicatorColor = {
    [BrowsingMode.SFW]: 'blue',
    [BrowsingMode.NSFW]: undefined,
    [BrowsingMode.All]: 'red',
  }[browsingMode];

  const label = {
    [BrowsingMode.SFW]: <IconShield {...indicatorProps} />,
    [BrowsingMode.NSFW]: undefined,
    [BrowsingMode.All]: <IconShieldOff {...indicatorProps} />,
  }[browsingMode];

  return (
    <Popover zIndex={constants.imageGeneration.drawerZIndex + 1} withArrow withinPortal>
      <Popover.Target>
        <Indicator
          color={indicatorColor}
          disabled={!indicatorColor}
          label={label}
          radius={10}
          offset={4}
          withBorder
          styles={{
            indicator: {
              padding: 0,
              width: 20,
              height: '20px !important',
            },
          }}
        >
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
  iconProps?: TablerIconsProps;
};

export function BrowsingModeMenu() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const setBrowsingMode = useFiltersContext((state) => state.setBrowsingMode);

  // const [showDecorations, setShowDecorations] = useLocalStorage({
  //   key: 'showDecorations',
  //   defaultValue: true,
  // });

  const handleChange = (mode: BrowsingMode) => {
    setBrowsingMode(mode);
    invalidateModeratedContentDebounced(queryUtils);
  };

  const isMobile = useIsMobile();
  if (!currentUser?.showNsfw) return null;

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
            onChange={handleChange}
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
          <BrowsingLevelsGrouped />
        </>
      )}
      {showBlurToggle && (
        <BlurToggle iconProps={{ size: 20 }}>
          {({ toggle, blurred }) => (
            <Group spacing={10}>
              <Text size="xs" weight={500}>
                Blur Mature Content
              </Text>
              <Switch ml="auto" checked={blurred} onChange={() => toggle()} />
            </Group>
          )}
        </BlurToggle>
      )}
      {/* <Group spacing="xs">
        <Text size="xs" weight={500}>
          Event Cosmetics
        </Text>
        <Switch
          ml="auto"
          checked={showDecorations}
          onChange={() => setShowDecorations((show) => !show)}
        />
      </Group> */}
    </Stack>
  );
}
