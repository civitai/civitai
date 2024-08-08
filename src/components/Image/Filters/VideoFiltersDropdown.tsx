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
import { MetricTimeframe } from '@prisma/client';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { useState } from 'react';
import { PeriodFilter } from '~/components/Filters';
import { TechniqueMultiSelect } from '~/components/Technique/TechniqueMultiSelect';
import { ToolSelect } from '~/components/Tool/ToolMultiSelect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import useIsClient from '~/hooks/useIsClient';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { activeBaseModels, BaseModel } from '~/server/common/constants';
import { GetInfiniteImagesInput } from '~/server/schema/image.schema';

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
    [theme.fn.smallerThan('sm')]: {
      width: '100%',
    },
  },

  indicatorRoot: { lineHeight: 1 },
  indicatorIndicator: { lineHeight: 1.6 },
}));

export function VideoFiltersDropdown({ query, onChange, isFeed, ...buttonProps }: Props) {
  const { classes, theme, cx } = useStyles();
  const mobile = useIsMobile();
  const isClient = useIsClient();
  const currentUser = useCurrentUser();

  const [opened, setOpened] = useState(false);

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.videos,
    setFilters: state.setVideoFilters,
  }));

  const mergedFilters = query || filters;

  const filterLength =
    (mergedFilters.withMeta ? 1 : 0) +
    (mergedFilters.hidden ? 1 : 0) +
    (!!mergedFilters.tools?.length ? 1 : 0) +
    (!!mergedFilters.techniques?.length ? 1 : 0) +
    (mergedFilters.period && mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0) +
    (mergedFilters.baseModels?.length ?? 0);

  const handleChange: Props['onChange'] = (value) => {
    onChange ? onChange(value) : setFilters(value);
  };

  const clearFilters = () => {
    const reset = {
      types: undefined,
      withMeta: false,
      hidden: false,
      period: MetricTimeframe.AllTime,
      baseModels: [],
      tools: [],
      techniques: [],
    };

    handleChange(reset);
  };

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
        {...buttonProps}
        rightIcon={<IconChevronDown className={cx({ [classes.opened]: opened })} size={16} />}
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
    <Stack spacing="lg" p="md">
      <Stack spacing="md">
        <Divider label="Time period" labelProps={{ weight: 'bold', size: 'sm' }} />
        {mergedFilters?.period && onChange ? (
          <PeriodFilter
            type="videos"
            variant="chips"
            value={mergedFilters.period}
            onChange={(period) => onChange({ period })}
          />
        ) : (
          <PeriodFilter type="videos" variant="chips" />
        )}
      </Stack>

      <Stack spacing="md">
        <Divider label="Base model" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={mergedFilters.baseModels ?? []}
          onChange={(baseModels: BaseModel[]) => handleChange({ baseModels })}
          multiple
          my={4}
        >
          {activeBaseModels.map((baseModel, index) => (
            <Chip key={index} value={baseModel} {...chipProps}>
              {baseModel}
            </Chip>
          ))}
        </Chip.Group>
      </Stack>
      <Stack spacing="md">
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
        </Group>
      </Stack>

      <Stack spacing="md">
        <Divider label="Tools" labelProps={{ weight: 'bold', size: 'sm' }} />
        <ToolSelect
          value={(mergedFilters.tools ?? [])[0]}
          onChange={(tool) => handleChange({ tools: tool ? [tool] : [] })}
          placeholder="Created with..."
        />
      </Stack>

      <Stack spacing="md">
        <Divider label="Techniques" labelProps={{ weight: 'bold', size: 'sm' }} />
        <TechniqueMultiSelect
          value={mergedFilters.techniques ?? []}
          onChange={(techniques) => handleChange({ techniques })}
          placeholder="Created with..."
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
          size="90%"
          position="bottom"
          styles={{
            drawer: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--mantine-header-height))',
              overflowY: 'auto',
            },
            body: { padding: 0, overflowY: 'auto' },
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
      <Popover.Dropdown maw={468} p={0} w="100%">
        {dropdown}
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  query?: Partial<GetInfiniteImagesInput>;
  onChange?: (params: Partial<GetInfiniteImagesInput>) => void;
  isFeed?: boolean;
};
