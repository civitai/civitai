import {
  Button,
  ButtonProps,
  Chip,
  ChipProps,
  createStyles,
  Divider,
  Drawer,
  Group,
  Indicator,
  Popover,
  Stack,
} from '@mantine/core';
import { MediaType, MetricTimeframe } from '@prisma/client';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { PeriodFilter } from '~/components/Filters';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import useIsClient from '~/hooks/useIsClient';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { getDisplayName } from '~/utils/string-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { ToolMultiSelect } from '~/components/Tool/ToolMultiSelect';
import { TechniqueMultiSelect } from '~/components/Technique/TechniqueMultiSelect';

// TODO: adjust filter as we begin to support more media types
const availableMediaTypes = Object.values(MediaType).filter(
  (value) => value === 'image' || value === 'video'
);

const useStyles = createStyles((theme) => ({
  label: {
    fontSize: 12,
    fontWeight: 600,

    '&[data-checked]': {
      '&, &:hover': {
        color: theme.colorScheme === 'dark' ? theme.white : theme.black,
        border: `1px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`,
      },

      '&[data-variant="filled"]': {
        // color: theme.colorScheme === 'dark' ? theme.white : theme.black,
        backgroundColor: 'transparent',
      },
    },
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

export function ImageFiltersDropdown({
  query,
  onChange,
  isFeed,
  filterType = 'images',
  ...buttonProps
}: Props) {
  const { classes, theme, cx } = useStyles();
  const mobile = useIsMobile();
  const isClient = useIsClient();
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator;

  const [opened, setOpened] = useState(false);

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state[filterType],
    setFilters: filterType === 'images' ? state.setImageFilters : state.setModelImageFilters,
  }));

  const mergedFilters = query || filters;

  const filterLength =
    (mergedFilters.types?.length ?? 0) +
    (mergedFilters.withMeta ? 1 : 0) +
    (mergedFilters.hidden ? 1 : 0) +
    (mergedFilters.fromPlatform ? 1 : 0) +
    (mergedFilters.notPublished ? 1 : 0) +
    (mergedFilters.period && mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0);

  const clearFilters = useCallback(() => {
    const reset = {
      types: undefined,
      withMeta: false,
      hidden: false,
      followed: false,
      fromPlatform: false,
      notPublished: false,
      period: MetricTimeframe.AllTime,
    };

    if (onChange) onChange(reset);
    else setFilters(reset);
  }, [onChange, setFilters]);

  const chipProps: Partial<ChipProps> = {
    size: 'sm',
    radius: 'xl',
    variant: 'filled',
    classNames: classes,
    tt: 'capitalize',
  };

  const handleChange: Props['onChange'] = (value) => {
    onChange ? onChange(value) : setFilters(value);
  };

  const target = (
    <Indicator
      offset={4}
      label={isClient && filterLength ? filterLength : undefined}
      size={16}
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
        rightIcon={<IconChevronDown className={cx({ [classes.opened]: opened })} size={16} />}
        {...buttonProps}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
      >
        <Group spacing={4} noWrap>
          <IconFilter size={16} />
          Filters
        </Group>
      </Button>
    </Indicator>
  );

  const dropdown = (
    <Stack spacing="lg">
      <Stack spacing="md">
        <Divider label="Time period" labelProps={{ weight: 'bold', size: 'sm' }} />
        {query?.period && onChange ? (
          <PeriodFilter
            type={filterType}
            variant="chips"
            value={query.period}
            onChange={(period) => onChange({ period })}
          />
        ) : (
          <PeriodFilter type={filterType} variant="chips" />
        )}
      </Stack>
      <Stack spacing="md">
        <Divider label="Media type" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={mergedFilters.types ?? []}
          onChange={(types: MediaType[]) => handleChange({ types })}
          multiple
        >
          {availableMediaTypes.map((type, index) => (
            <Chip {...chipProps} key={index} value={type}>
              {getDisplayName(type)}
            </Chip>
          ))}
        </Chip.Group>
        <Divider label="Modifiers" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Group spacing={8}>
          <Chip
            {...chipProps}
            checked={mergedFilters.withMeta}
            onChange={(checked) => handleChange({ withMeta: checked })}
          >
            Metadata only
          </Chip>
          {isFeed && currentUser && (
            <>
              <Chip
                {...chipProps}
                checked={mergedFilters.hidden}
                onChange={(checked) => handleChange({ hidden: checked })}
              >
                Hidden
              </Chip>
            </>
          )}
          <Chip
            {...chipProps}
            checked={mergedFilters.fromPlatform}
            onChange={(checked) => handleChange({ fromPlatform: checked })}
          >
            Made On-site
          </Chip>
          {isModerator && (
            <Chip
              {...chipProps}
              checked={mergedFilters.notPublished}
              onChange={(checked) => handleChange({ notPublished: checked })}
            >
              Not Published
            </Chip>
          )}
        </Group>

        {/* <Divider label="Tools" labelProps={{ weight: 'bold', size: 'sm' }} />
        <ToolMultiSelect
          value={mergedFilters.tools ?? []}
          onChange={(tools) => handleChange({ tools })}
        />

        <Divider label="Techniques" labelProps={{ weight: 'bold', size: 'sm' }} />
        <TechniqueMultiSelect
          value={mergedFilters.techniques ?? []}
          onChange={(techniques) => handleChange({ techniques })}
        /> */}
      </Stack>
      {filterLength > 0 && (
        <Button
          color="gray"
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
          onClick={clearFilters}
          fullWidth
        >
          Clear all filters
        </Button>
      )}
    </Stack>
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
              overflowY: 'auto',
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
    <Popover
      zIndex={200}
      position="bottom-end"
      shadow="md"
      radius={12}
      onClose={() => setOpened(false)}
      middlewares={{ flip: true, shift: true }}
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p="md" w="100%">
        {dropdown}
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  query?: Partial<GetInfiniteImagesInput>;
  onChange?: (params: Partial<GetInfiniteImagesInput>) => void;
  isFeed?: boolean;
  filterType?: 'images' | 'modelImages';
};
