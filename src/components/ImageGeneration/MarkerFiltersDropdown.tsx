import {
  Button,
  ButtonProps,
  Chip,
  ChipProps,
  createStyles,
  Divider,
  Group,
  Indicator,
  Popover,
  PopoverProps,
  ScrollArea,
  Stack,
} from '@mantine/core';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { ReactNode, useState } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { IsClient } from '~/components/IsClient/IsClient';
import { GenerationFilterSchema, useFiltersContext } from '~/providers/FiltersProvider';
import { GenerationReactType } from '~/server/common/enums';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { containerQuery } from '~/utils/mantine-css-helpers';

export function MarkerFiltersDropdown(props: Props) {
  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.generation,
    setFilters: state.setGenerationFilters,
  }));

  return <DumbMarkerFiltersDropdown {...props} filters={filters} setFilters={setFilters} />;
}

// const ICONS = {
//   default: IconFilter,
//   liked: IconThumbUpFilled,
//   disliked: IconThumbDownFilled,
//   favorited: IconHeartFilled,
// };

// function getIcon(type: MarkerType | undefined) {
//   return ICONS[type || 'default'];
// }

export function DumbMarkerFiltersDropdown({
  filters,
  setFilters,
  filterMode = 'local',
  position = 'bottom-start',
  isFeed,
  text,
  hideMediaTypes = false,
  ...buttonProps
}: Props & {
  filters: Partial<GenerationFilterSchema>;
  setFilters: (filters: Partial<GenerationFilterSchema>) => void;
}) {
  const { classes, cx, theme } = useStyles();

  const [opened, setOpened] = useState(false);

  const [currentMarker, setMarker] = useState<GenerationReactType | undefined>(filters.marker);

  if (filters.marker !== currentMarker) {
    setMarker(filters.marker);
  }

  let filterLength = 0;
  if (filters.marker) filterLength += 1;
  if (filters.tags) filterLength += filters.tags.length;

  const chipProps: Partial<ChipProps> = {
    size: 'sm',
    radius: 'xl',
    variant: 'filled',
    classNames: classes,
    tt: 'capitalize',
  };

  const dropdown = (
    <Stack spacing={8}>
      {!hideMediaTypes && (
        <>
          <Divider label="Generation Type" labelProps={{ weight: 'bold', size: 'sm' }} />
          <div className="flex gap-2">
            <Chip
              checked={!filters.tags?.length}
              onChange={() => setFilters({ tags: [] })}
              {...chipProps}
            >
              All
            </Chip>
            <Chip
              checked={filters.tags?.includes(WORKFLOW_TAGS.IMAGE) ?? false}
              onChange={() => setFilters({ tags: [WORKFLOW_TAGS.IMAGE] })}
              {...chipProps}
            >
              Images
            </Chip>
            <Chip
              checked={filters.tags?.includes(WORKFLOW_TAGS.VIDEO) ?? false}
              onChange={() => setFilters({ tags: [WORKFLOW_TAGS.VIDEO] })}
              {...chipProps}
            >
              Videos
            </Chip>
          </div>
        </>
      )}
      <Divider label="Reactions" labelProps={{ weight: 'bold', size: 'sm' }} />
      <div className="flex gap-2">
        {Object.values(GenerationReactType).map((marker) => {
          return (
            <Chip
              key={marker}
              checked={marker === filters.marker}
              onChange={(checked) => {
                setMarker(checked ? marker : undefined);
                setFilters({ marker: checked ? marker : undefined });
              }}
              {...chipProps}
            >
              <span>{marker}</span>
            </Chip>
          );
        })}
      </div>
    </Stack>
  );

  return (
    <IsClient>
      <Popover
        zIndex={300}
        position={position}
        shadow="md"
        onClose={() => setOpened(false)}
        withinPortal
      >
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
          <Popover.Target>
            <FilterButton icon={IconFilter} onClick={() => setOpened((o) => !o)} active={opened}>
              {text}
            </FilterButton>
            {/* <Button
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
                {text}
              </Group>
            </Button> */}
          </Popover.Target>
        </Indicator>
        <Popover.Dropdown maw={576} w="100%">
          <ScrollArea.Autosize maxHeight={'calc(90vh - var(--header-height) - 56px)'} type="hover">
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
  text?: ReactNode;
  hideMediaTypes?: boolean;
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

  // iconWrapper: {
  //   ref: getRef('iconWrapper'),
  //   display: 'none',
  // },
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
