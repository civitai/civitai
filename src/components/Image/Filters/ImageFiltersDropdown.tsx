import {
  Popover,
  Group,
  Indicator,
  Stack,
  Divider,
  Chip,
  ChipProps,
  Button,
  createStyles,
  Drawer,
  Switch,
} from '@mantine/core';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { MediaType, MetricTimeframe } from '@prisma/client';
import { getDisplayName } from '~/utils/string-helpers';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { useCallback, useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { PeriodFilter } from '~/components/Filters';
import { GetInfiniteImagesInput } from '~/server/schema/image.schema';

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
        color: theme.white,
        border: `1px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`,
      },

      '&[data-variant="filled"]': {
        backgroundColor: 'transparent',
      },
    },
  },
  opened: {
    transform: 'rotate(180deg)',
    transition: 'transform 200ms ease',
  },

  actionButton: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',
    },
  },
}));

export function ImageFiltersDropdown({ query, onChange }: Props) {
  const { classes, theme, cx } = useStyles();
  const mobile = useIsMobile();

  const [opened, setOpened] = useState(false);

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.images,
    setFilters: state.setImageFilters,
  }));

  const mergedFilters = query || filters;

  const filterLength =
    (mergedFilters.types?.length ?? 0) +
    (mergedFilters.withMeta ? 1 : 0) +
    (mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0);

  const clearFilters = useCallback(() => {
    const reset = {
      types: undefined,
      withMeta: false,
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

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      showZero={false}
      dot={false}
      inline
    >
      <Button
        className={classes.actionButton}
        color="gray"
        radius="xl"
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        rightIcon={<IconChevronDown className={cx({ [classes.opened]: opened })} size={16} />}
        onClick={() => setOpened((o) => !o)}
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
            type="images"
            variant="chips"
            value={query.period}
            onChange={(period) => onChange({ period })}
          />
        ) : (
          <PeriodFilter type="images" variant="chips" />
        )}
      </Stack>
      <Stack spacing="md">
        <Divider label="Media type" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={mergedFilters.types ?? []}
          onChange={(types: MediaType[]) =>
            onChange ? onChange({ types }) : setFilters({ types })
          }
          multiple
        >
          {availableMediaTypes.map((type, index) => (
            <Chip {...chipProps} key={index} value={type}>
              {getDisplayName(type)}
            </Chip>
          ))}
        </Chip.Group>
        <Switch
          label="Metadata only"
          checked={mergedFilters.withMeta}
          onChange={({ target }) =>
            onChange
              ? onChange({ withMeta: target.checked })
              : setFilters({ withMeta: target.checked })
          }
        />
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
          withCloseButton={false}
          size="90%"
          position="bottom"
          styles={{
            body: { padding: 16 },
            drawer: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--mantine-header-height))',
              overflowY: 'auto',
            },
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

type Props = {
  query?: Partial<GetInfiniteImagesInput>;
  onChange?: (params: Partial<GetInfiniteImagesInput>) => void;
};
