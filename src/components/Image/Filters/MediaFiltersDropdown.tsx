import {
  ActionIcon,
  Button,
  ButtonProps,
  Chip,
  Divider,
  Drawer,
  Indicator,
  Popover,
  ScrollArea,
  Stack,
  useMantineTheme,
  Tooltip,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronDown, IconChevronUp, IconFilter } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { PeriodFilter } from '~/components/Filters';
import { FilterChip } from '~/components/Filters/FilterChip';
import { TechniqueMultiSelect } from '~/components/Technique/TechniqueMultiSelect';
import { ToolMultiSelect } from '~/components/Tool/ToolMultiSelect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import useIsClient from '~/hooks/useIsClient';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { activeBaseModels, BaseModel } from '~/server/common/constants'; // Add this import
import { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { getDisplayName, titleCase } from '~/utils/string-helpers';

// TODO: adjust filter as we begin to support more media types
const availableMediaTypes = Object.values(MediaType).filter(
  (value) => value === 'image' || value === 'video'
);

const baseModelLimit = 3;

export function MediaFiltersDropdown({
  query,
  onChange,
  isFeed,
  filterType = 'images',
  hideBaseModels = false,
  hideMediaTypes = false,
  hideTools = false,
  ...buttonProps
}: Props) {
  const theme = useMantineTheme();
  const mobile = useIsMobile();
  const isClient = useIsClient();
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator;

  const [opened, setOpened] = useState(false);
  const [truncateBaseModels, setTruncateBaseModels] = useLocalStorage({
    key: 'image-filter-truncate-base-models',
    defaultValue: false,
  });

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state[filterType],
    setFilters:
      filterType === 'images'
        ? state.setImageFilters
        : filterType === 'videos'
        ? state.setVideoFilters
        : state.setModelImageFilters,
  }));

  const mergedFilters = query || filters;

  const displayedBaseModels = truncateBaseModels
    ? activeBaseModels.filter(
        (bm, idx) => idx < baseModelLimit || mergedFilters.baseModels?.includes(bm)
      )
    : activeBaseModels;

  // maybe have individual filter length with labels next to them

  const filterLength =
    ('types' in mergedFilters && !hideMediaTypes ? mergedFilters.types?.length ?? 0 : 0) +
    (mergedFilters.withMeta ? 1 : 0) +
    (mergedFilters.requiringMeta ? 1 : 0) +
    (mergedFilters.hidden ? 1 : 0) +
    (mergedFilters.fromPlatform ? 1 : 0) +
    (mergedFilters.hideManualResources ? 1 : 0) +
    (mergedFilters.hideAutoResources ? 1 : 0) +
    (mergedFilters.notPublished ? 1 : 0) +
    (mergedFilters.scheduled ? 1 : 0) +
    (!!mergedFilters.tools?.length ? 1 : 0) +
    (!!mergedFilters.techniques?.length ? 1 : 0) +
    (mergedFilters.period && mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0) +
    (!hideBaseModels ? mergedFilters.baseModels?.length ?? 0 : 0) +
    (!!mergedFilters.remixesOnly || !!mergedFilters.nonRemixesOnly ? 1 : 0);

  const clearFilters = useCallback(() => {
    const reset = {
      types: undefined,
      withMeta: false,
      requiringMeta: false,
      hidden: false,
      fromPlatform: false,
      notPublished: false,
      scheduled: false,
      hideManualResources: false,
      hideAutoResources: false,
      tools: [],
      techniques: [],
      period: MetricTimeframe.AllTime,
      baseModels: [],
      remixesOnly: false,
      nonRemixesOnly: false,
    };

    if (onChange) onChange(reset);
    else setFilters(reset);
  }, [onChange, setFilters]);

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
      inline
    >
      <FilterButton icon={IconFilter} onClick={() => setOpened((o) => !o)} active={opened}>
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdown = (
    <Stack spacing="lg" p="md">
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
      {!hideBaseModels && (
        <Stack spacing="md">
          <Divider label="Base model" labelProps={{ weight: 'bold', size: 'sm' }} />
          <Chip.Group
            spacing={8}
            value={mergedFilters.baseModels ?? []}
            onChange={(baseModels: BaseModel[]) => handleChange({ baseModels })}
            multiple
            my={4}
          >
            {displayedBaseModels.map((baseModel, index) => (
              <FilterChip key={index} value={baseModel}>
                <span>{baseModel}</span>
              </FilterChip>
            ))}
            {activeBaseModels.length > baseModelLimit && (
              <ActionIcon
                variant="transparent"
                size="sm"
                onClick={() => setTruncateBaseModels((prev) => !prev)}
              >
                {truncateBaseModels ? (
                  <IconChevronDown strokeWidth={3} />
                ) : (
                  <IconChevronUp strokeWidth={3} />
                )}
              </ActionIcon>
            )}
          </Chip.Group>
        </Stack>
      )}

      <Stack spacing="md">
        {!hideMediaTypes && (
          <>
            <Divider label="Media type" labelProps={{ weight: 'bold', size: 'sm' }} />
            <Chip.Group
              spacing={8}
              value={mergedFilters.types ?? []}
              onChange={(types: MediaType[]) => handleChange({ types })}
              multiple
            >
              {availableMediaTypes.map((type, index) => (
                <FilterChip key={index} value={type}>
                  <span>{titleCase(getDisplayName(type))}</span>
                </FilterChip>
              ))}
            </Chip.Group>
          </>
        )}
        <Divider label="Modifiers" labelProps={{ weight: 'bold', size: 'sm' }} />
        <div className="flex flex-wrap gap-2">
          <FilterChip
            checked={mergedFilters.withMeta}
            onChange={(checked) => handleChange({ withMeta: checked })}
          >
            <span>Metadata only</span>
          </FilterChip>
          {currentUser && (
            <FilterChip
              checked={mergedFilters.requiringMeta}
              onChange={(checked) => handleChange({ requiringMeta: checked })}
            >
              <Tooltip label="Only shows your images that are missing metadata">
                <span>Requiring Metadata</span>
              </Tooltip>
            </FilterChip>
          )}
          {isFeed && currentUser && (
            <>
              <FilterChip
                checked={mergedFilters.hidden}
                onChange={(checked) => handleChange({ hidden: checked })}
              >
                <span>Hidden</span>
              </FilterChip>
            </>
          )}
          <FilterChip
            checked={mergedFilters.fromPlatform}
            onChange={(checked) => handleChange({ fromPlatform: checked })}
          >
            <span>Made On-site</span>
          </FilterChip>
          <FilterChip
            checked={mergedFilters.nonRemixesOnly}
            onChange={(checked) => {
              handleChange({ nonRemixesOnly: checked, remixesOnly: checked ? false : undefined });
            }}
          >
            <span>Originals Only</span>
          </FilterChip>
          <FilterChip
            checked={mergedFilters.remixesOnly}
            onChange={(checked) =>
              handleChange({ remixesOnly: checked, nonRemixesOnly: checked ? false : undefined })
            }
          >
            <span>Remixes Only</span>
          </FilterChip>
        </div>

        {filterType === 'modelImages' && (
          <>
            <Divider label="Resources" labelProps={{ weight: 'bold', size: 'sm' }} />
            <div className="flex gap-2">
              <FilterChip
                checked={mergedFilters.hideManualResources}
                onChange={(checked) => handleChange({ hideManualResources: checked })}
              >
                <span>Hide manually-added</span>
              </FilterChip>
              <FilterChip
                checked={mergedFilters.hideAutoResources}
                onChange={(checked) => handleChange({ hideAutoResources: checked })}
              >
                <span>Hide auto-detected</span>
              </FilterChip>
            </div>
          </>
        )}

        {isModerator && (
          <>
            <Divider label="Moderator" labelProps={{ weight: 'bold', size: 'sm' }} />
            <div className="flex gap-2">
              <FilterChip
                checked={mergedFilters.notPublished}
                onChange={(checked) => handleChange({ notPublished: checked })}
              >
                <span>Not Published</span>
              </FilterChip>
              <FilterChip
                checked={mergedFilters.scheduled}
                onChange={(checked) => handleChange({ scheduled: checked })}
              >
                <span>Scheduled</span>
              </FilterChip>
            </div>
          </>
        )}

        {!hideTools && (
          <>
            <Divider label="Tools" labelProps={{ weight: 'bold', size: 'sm' }} />
            <ToolMultiSelect
              value={mergedFilters.tools ?? []}
              onChange={(tools) => handleChange({ tools })}
              placeholder="Created with..."
            />
          </>
        )}

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
              maxHeight: 'calc(100dvh - var(--header-height))',
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
      withinPortal
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p={0} w="100%">
        <ScrollArea.Autosize type="hover" maxHeight={'calc(90vh - var(--header-height) - 56px)'}>
          {dropdown}
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  query?: Partial<GetInfiniteImagesInput>;
  onChange?: (params: Partial<GetInfiniteImagesInput>) => void;
  isFeed?: boolean;
  filterType?: 'images' | 'videos' | 'modelImages';
  hideBaseModels?: boolean;
  hideMediaTypes?: boolean;
  hideTools?: boolean;
};
