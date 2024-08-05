import {
  Button,
  Chip,
  ChipProps,
  createStyles,
  Divider,
  Group,
  Indicator,
  Popover,
  Stack,
  Drawer,
  PopoverProps,
  ScrollArea,
  ButtonProps,
} from '@mantine/core';
import { IconChevronDown, IconFilter, IconThumbUp, IconThumbDown, IconHeart, IconTag, IconThumbUpFilled, IconThumbDownFilled, IconHeartFilled, IconTagFilled } from '@tabler/icons-react';
import { useState, useEffect } from 'react';
import { IsClient } from '~/components/IsClient/IsClient';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { MarkerFilterSchema, useFiltersContext } from '~/providers/FiltersProvider';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useIsMobile } from '~/hooks/useIsMobile';
import { MarkerType } from '~/server/common/enums';
import { filter } from 'lodash';

export function MarkerFiltersDropdown(props: Props) {
  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.markers,
    setFilters: state.setMarkerFilters,
  }));

  return (
    <DumbMarkerFiltersDropdown {...props} filters={filters} setFilters={setFilters} />
  );
}

const ICONS = {
  default: IconFilter,
  liked: IconThumbUpFilled,
  disliked: IconThumbDownFilled,
  faved: IconHeartFilled,
  tagged: IconTagFilled
};

function getIcon(type: MarkerType | 'tagged' | undefined) {
  return ICONS[type || 'default'];
}

export function DumbMarkerFiltersDropdown({
  filters,
  setFilters,
  filterMode = 'local',
  position = 'bottom-end',
  isFeed,
  ...buttonProps
}: Props & {
  filters: Partial<MarkerFilterSchema>;
  setFilters: (filters: Partial<MarkerFilterSchema>) => void;
}) {
  const { classes, cx, theme } = useStyles();
  const flags = useFeatureFlags();
  const mobile = useIsMobile();

  const [opened, setOpened] = useState(false);

  const localMode = filterMode === 'local';

  const [currentMarker, setMarker] = useState<MarkerType | undefined>();

  useEffect(() => {
    setMarker(filters.marker);
  }, []);

  const filterLength = 0;

  // const clearFilters = useCallback(() => {
  //   const reset = { marker: undefined, tags: [] };
  //   setFilters(reset);
  // }, [localMode, setFilters]);

  const chipProps: Partial<ChipProps> = {
    size: 'sm',
    radius: 'xl',
    variant: 'filled',
    classNames: classes,
    tt: 'capitalize',
  };

  const Icon = getIcon(currentMarker);

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={14}
      zIndex={10}
      showZero={false}
      dot={false}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
        className={classes.actionButton}
        color="gray"
        radius="xl"
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        {...buttonProps}
        rightIcon={<IconChevronDown className={cx({ [classes.opened]: opened })} size={16} />}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
      >
        <Group spacing={4} noWrap>
          <Icon size={16} />
        </Group>
      </Button>
    </Indicator>
  );

  const dropdown = (
    <Stack spacing={8}>
      <Stack spacing={0}>
        <Divider label="Markers" labelProps={{ weight: 'bold', size: 'sm' }} mb={4} />
        <Group spacing={8} mb={4}>
          {Object.values(MarkerType).map((marker) => {
            const Icon = getIcon(marker);

            return (
              <Chip
                key={marker}
                checked={marker === currentMarker}
                onChange={(checked) => {
                  setFilters({ marker: checked ? marker : undefined });
                  setMarker(checked ? marker : undefined);
                }}
                {...chipProps}>
                <Group spacing={4} noWrap>
                  <Icon size={16} /> {marker}
                </Group>
              </Chip>
            );
          })}
        </Group>
      </Stack>
    </Stack >
  );

  if (mobile)
    return (
      <>
        {target}
        <Drawer
          opened={opened}
          onClose={() => setOpened(false)}
          size="90%"
          position="bottom"
          styles={{
            drawer: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--mantine-header-height))',
            },
            body: { padding: 16, paddingTop: 0, overflowY: 'auto' },
            header: { padding: '4px 8px' },
            closeButton: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
          }}
        >
          {dropdown}
        </Drawer>
      </>
    );

  return (
    <IsClient>
      <Popover
        zIndex={200}
        position={position}
        shadow="md"
        onClose={() => setOpened(false)}
        middlewares={{ flip: true, shift: true }}
        withinPortal
        withArrow
      >
        <Popover.Target>{target}</Popover.Target>
        <Popover.Dropdown maw={576} w="100%">
          <ScrollArea.Autosize
            maxHeight={'calc(90vh - var(--mantine-header-height) - 56px)'}
            type="hover"
          >
            {dropdown}
          </ScrollArea.Autosize>
        </Popover.Dropdown>
      </Popover>
    </IsClient>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  filterMode?: 'local' | 'query';
  position?: PopoverProps['position'];
  isFeed?: boolean;
};

const useStyles = createStyles((theme, _params, getRef) => ({
  label: {
    fontSize: 12,
    fontWeight: 600,

    '&[data-checked]': {
      '&, &:hover': {
        color: theme.colorScheme === 'dark' ? theme.white : theme.black,
        border: `1px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`,
      },

      '&[data-variant="filled"]': {
        backgroundColor: 'transparent',
      },
    },
  },

  iconWrapper: {
    ref: getRef('iconWrapper'),
    display: 'none',
  },
  opened: {
    transform: 'rotate(180deg)',
    transition: 'transform 200ms ease',
  },

  actionButton: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',
    },
  },

  indicatorRoot: { lineHeight: 1 },
  indicatorIndicator: { lineHeight: 1.6 },
}));
