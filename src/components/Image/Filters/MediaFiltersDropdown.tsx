import type { ButtonProps } from '@mantine/core';
import { Chip, Divider, Drawer, Indicator, ScrollArea, Stack, Group, Text } from '@mantine/core';
import { Popover, Tooltip } from '~/components/MantineOverlays';
import { IconFilter } from '@tabler/icons-react';
import { useCallback, useMemo } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { PeriodFilter } from '~/components/Filters';
import { FilterChip } from '~/components/Filters/FilterChip';
import { JumpToMonthFilter } from '~/components/Filters/JumpToMonthFilter';
import { isJumpToSort, jumpToPatch, periodPatch } from '~/shared/utils/jump-to-month';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
import { getDefaultMediaTypes } from '~/components/Image/image.utils';
import { TechniqueMultiSelect } from '~/components/Technique/TechniqueMultiSelect';
import { ToolMultiSelect } from '~/components/Tool/ToolMultiSelect';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import { useHatTurfFeedPlayer } from '~/components/HatTurf/useHatTurfFeedPlayer';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDomainColor } from '~/hooks/useDomainColor';
import useIsClient from '~/hooks/useIsClient';
import { isMobileDevice, useIsMobile } from '~/hooks/useIsMobile';
import { BaseModelFilterSelect } from '~/components/SfwOnlyBadge/BaseModelFilterSelect';
import { useFiltersContext } from '~/providers/FiltersProvider';
import type { GetInfiniteImagesOutput } from '~/server/schema/image.schema';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { getDisplayName, titleCase } from '~/utils/string-helpers';
import type { MediaFilterKey } from '~/components/Image/Filters/media-filter-keys';

export type { MediaFilterKey };

const moderatorKeys: MediaFilterKey[] = [
  'poiOnly',
  'minorOnly',
  'disablePoi',
  'disableMinor',
  'notPublished',
];
const hatTurfKeys: MediaFilterKey[] = ['hatTeams', 'hatTurfMine', 'hideTurfHats', 'hideWornHats'];

// TODO: adjust filter as we begin to support more media types
const availableMediaTypes = Object.values(MediaType).filter(
  (value) => value === 'image' || value === 'video'
);

export function MediaFiltersDropdown({
  query,
  onChange,
  isFeed,
  isSameUser,
  filterType = 'images',
  hideBaseModels = false,
  hideMediaTypes = false,
  hideTools = false,
  exclude,
  unavailable,
  jumpToSort,
  style,
  ...buttonProps
}: Props) {
  const mobile = useIsMobile();
  const isClient = useIsClient();
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator;
  const domainColor = useDomainColor();
  const isGreen = domainColor === 'green';
  // Anonymous users on green are hard-capped to PG by the domain rule, so the
  // toggle would be a no-op for them. Only logged-in users actually have
  // PG-13 access to opt in/out of.
  const showPG13Toggle = isGreen && !!currentUser;
  const showChallengeToggle = filterType !== 'modelImages';
  const showJumpTo = jumpToSort !== undefined;
  const turfPlayer = useHatTurfFeedPlayer();
  const teamColor = useTeamColor();
  // The legacy hide* booleans fold into `excluded` so there is one gate, not two.
  const excluded = useMemo<MediaFilterKey[]>(
    () => [
      ...(exclude ?? []),
      ...(unavailable?.keys ?? []),
      ...(hideMediaTypes ? (['types'] as const) : []),
      ...(hideBaseModels ? (['baseModels'] as const) : []),
      ...(hideTools ? (['tools'] as const) : []),
    ],
    [exclude, unavailable, hideMediaTypes, hideBaseModels, hideTools]
  );
  const shows = useCallback((key: MediaFilterKey) => !excluded.includes(key), [excluded]);
  // Hat Turf's filters, on the main image feed for players only (as the server serves them).
  const showTurf = filterType === 'images' && !!isFeed && !!turfPlayer && shows('hideTurfHats');
  // A section whose every chip is excluded would otherwise render as a lone divider.
  const showResources = shows('hideManualResources') || shows('hideAutoResources');
  // Greyed only where the control would otherwise appear for this viewer.
  const offeredHere = (key: MediaFilterKey) => {
    if (moderatorKeys.includes(key)) return !!isModerator;
    if (hatTurfKeys.includes(key)) return filterType === 'images' && !!isFeed && !!turfPlayer;
    switch (key) {
      case 'scheduled':
        return !!currentUser;
      case 'requiringMeta':
        return !!(isSameUser || isModerator);
      case 'hidden':
        return !!isFeed && !!currentUser;
      case 'hideManualResources':
      case 'hideAutoResources':
        return filterType === 'modelImages';
      case 'hideChallenges':
        return showChallengeToggle;
      default:
        return true;
    }
  };
  const greyed = unavailable?.keys.filter(offeredHere) ?? [];
  const showModerator = (
    ['poiOnly', 'minorOnly', 'disablePoi', 'disableMinor', 'notPublished', 'scheduled'] as const
  ).some(shows);

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state[filterType],
    setFilters:
      filterType === 'images'
        ? state.setImageFilters
        : filterType === 'videos'
        ? state.setVideoFilters
        : state.setModelImageFilters,
  }));

  const committedFilters = useMemo(() => query || filters, [query, filters]);

  const handleApply = useCallback(
    (next: typeof committedFilters) => {
      if (onChange) onChange(next);
      else setFilters(next);
    },
    [onChange, setFilters]
  );

  const handleClear = useCallback(() => {
    // All values must be `undefined` so `removeEmpty` strips them from the URL
    // (when onChange writes to query params) and from the Zustand store. Using
    // `false` here would leave keys like `?withMeta=false` on the URL.
    const reset = {
      types: undefined,
      withMeta: undefined,
      requiringMeta: undefined,
      hidden: undefined,
      fromPlatform: undefined,
      // Only cleared when this dropdown actually SHOWS the control. On the
      // profile images/videos tabs the Published/Draft toggle owns
      // `notPublished` and the chip is excluded, so clearing it here would flip
      // a creator out of Drafts from a control that never displayed that state.
      // Same reasoning as `filterLength` below, which is already gated: a
      // dropdown should not own a filter it does not show.
      ...(shows('notPublished') ? { notPublished: undefined } : {}),
      scheduled: undefined,
      hideManualResources: undefined,
      hideAutoResources: undefined,
      tools: undefined,
      techniques: undefined,
      baseModels: undefined,
      remixesOnly: undefined,
      nonRemixesOnly: undefined,
      hideChallenges: undefined,
      disablePoi: undefined,
      disableMinor: undefined,
      poiOnly: undefined,
      minorOnly: undefined,
      includePG13: undefined,
      ...(showJumpTo ? { jumpTo: undefined } : {}),
      ...(showTurf
        ? {
            hatTeams: undefined,
            hatTurfMine: undefined,
            hideTurfHats: undefined,
            hideWornHats: undefined,
          }
        : {}),
    };
    // `period` is special: the URL path needs `undefined` so `removeEmpty`
    // strips `?period=AllTime`, but the Zustand store needs `AllTime` so
    // `PeriodFilter` keeps rendering its chips (it returns null when period
    // is undefined).
    //
    // The store path also restores the feed's default media-type scope instead
    // of clearing `types` outright — otherwise `removeEmpty` drops `types` and
    // the /images feed starts serving videos too. The URL path keeps `types`
    // undefined so it's stripped from the query string.
    if (onChange) onChange({ ...reset, period: undefined });
    else
      setFilters({
        ...reset,
        types: getDefaultMediaTypes(filterType),
        period: MetricTimeframe.AllTime,
      });
  }, [onChange, setFilters, filterType, shows, showJumpTo, showTurf]);

  const {
    opened,
    toggle,
    close,
    mergedFilters,
    isDirty,
    patchPending,
    apply,
    reset,
    clearAndClose,
  } = useStagedFilters({
    committed: committedFilters,
    onApply: handleApply,
    onClear: handleClear,
  });

  // Only the URL-backed callers carry it; the store's filter shape has no jump.
  const jumpTo = 'jumpTo' in mergedFilters ? mergedFilters.jumpTo : undefined;
  // A Hat Turf sort ranks over the whole event, so it has no time period.
  const hatSorted = showTurf && !!mergedFilters.hatSort;
  // The viewer's own live hats, whatever media they are on, so the type chips do not apply.
  const myHats = showTurf && !!mergedFilters.hatTurfMine;
  // Both are served by the database hydrate, which has no period or remix filter.
  const turfHydrated = hatSorted || myHats;

  // maybe have individual filter length with labels next to them

  // Every term is gated on `shows` as well: a count that includes a control the
  // caller excluded reads as an active filter the user cannot find or clear.
  const filterLength =
    ('types' in mergedFilters && shows('types') && !myHats ? mergedFilters.types?.length ?? 0 : 0) +
    (shows('withMeta') && mergedFilters.withMeta ? 1 : 0) +
    (shows('requiringMeta') && mergedFilters.requiringMeta ? 1 : 0) +
    (shows('hidden') && mergedFilters.hidden ? 1 : 0) +
    (shows('fromPlatform') && mergedFilters.fromPlatform ? 1 : 0) +
    (shows('hideManualResources') && mergedFilters.hideManualResources ? 1 : 0) +
    (shows('hideAutoResources') && mergedFilters.hideAutoResources ? 1 : 0) +
    (shows('notPublished') && mergedFilters.notPublished ? 1 : 0) +
    (shows('scheduled') && mergedFilters.scheduled ? 1 : 0) +
    (shows('tools') && !!mergedFilters.tools?.length ? 1 : 0) +
    (shows('techniques') && !!mergedFilters.techniques?.length ? 1 : 0) +
    (shows('period') &&
    !turfHydrated &&
    mergedFilters.period &&
    mergedFilters.period !== MetricTimeframe.AllTime
      ? 1
      : 0) +
    (hatSorted ? mergedFilters.hatTeams?.length ?? 0 : 0) +
    (myHats ? 1 : 0) +
    (showTurf && mergedFilters.hideTurfHats ? 1 : 0) +
    (showTurf && mergedFilters.hideWornHats ? 1 : 0) +
    (shows('baseModels') ? mergedFilters.baseModels?.length ?? 0 : 0) +
    (!turfHydrated &&
    ((shows('remixesOnly') && !!mergedFilters.remixesOnly) ||
      (shows('nonRemixesOnly') && !!mergedFilters.nonRemixesOnly))
      ? 1
      : 0) +
    (showChallengeToggle && shows('hideChallenges') && mergedFilters.hideChallenges ? 1 : 0) +
    (shows('poiOnly') && mergedFilters.poiOnly ? 1 : 0) +
    (shows('minorOnly') && mergedFilters.minorOnly ? 1 : 0) +
    (isModerator && shows('disablePoi') && mergedFilters.disablePoi ? 1 : 0) +
    (isModerator && shows('disableMinor') && mergedFilters.disableMinor ? 1 : 0) +
    (showPG13Toggle && shows('includePG13') && mergedFilters.includePG13 ? 1 : 0) +
    (showJumpTo && jumpTo && isJumpToSort(jumpToSort) ? 1 : 0);

  const handleChange: Props['onChange'] = (value) => {
    patchPending(value);
  };

  const target = (
    <Indicator
      offset={4}
      label={isClient && filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      inline
    >
      <FilterButton {...buttonProps} icon={IconFilter} onClick={toggle} active={opened}>
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdownBody = (
    <Stack gap="lg" p="md">
      {shows('period') && !turfHydrated && (
        <Stack gap="md">
          <Divider label="Time period" className="text-sm font-bold" mb={4} />
          <PeriodFilter
            type={filterType}
            variant="chips"
            value={mergedFilters.period ?? MetricTimeframe.AllTime}
            onChange={(period) => handleChange(showJumpTo ? periodPatch(period) : { period })}
          />
          {showJumpTo && (
            <JumpToMonthFilter
              value={jumpTo}
              sort={jumpToSort}
              onChange={(jumpTo) => handleChange(jumpToPatch(jumpTo, undefined))}
            />
          )}
        </Stack>
      )}
      <Stack gap="md">
        {shows('types') && !myHats && (
          <>
            <Divider label="Media type" className="text-sm font-bold" mb={4} />
            <Chip.Group
              value={mergedFilters.types ?? []}
              onChange={(types) => handleChange({ types: types as MediaType[] })}
              multiple
            >
              <Group gap={8}>
                {availableMediaTypes.map((type, index) => (
                  <FilterChip key={index} value={type}>
                    <span>{titleCase(getDisplayName(type))}</span>
                  </FilterChip>
                ))}
              </Group>
            </Chip.Group>
          </>
        )}
        <Divider label="Modifiers" className="text-sm font-bold" mb={4} />
        <div className="flex flex-wrap gap-2">
          {showPG13Toggle && shows('includePG13') && (
            <FilterChip
              checked={!!mergedFilters.includePG13}
              onChange={(checked) => handleChange({ includePG13: checked })}
            >
              <span>Include PG-13</span>
            </FilterChip>
          )}
          {shows('withMeta') && (
            <FilterChip
              checked={mergedFilters.withMeta}
              onChange={(checked) => handleChange({ withMeta: checked })}
            >
              <span>Metadata only</span>
            </FilterChip>
          )}
          {(isSameUser || isModerator) && shows('requiringMeta') && (
            <FilterChip
              checked={mergedFilters.requiringMeta}
              onChange={(checked) => handleChange({ requiringMeta: checked })}
            >
              <Tooltip label="Only shows images blocked for missing verified metadata">
                <span>Requiring Metadata</span>
              </Tooltip>
            </FilterChip>
          )}
          {isFeed && currentUser && shows('hidden') && (
            <>
              <FilterChip
                checked={mergedFilters.hidden}
                onChange={(checked) => handleChange({ hidden: checked })}
              >
                <span>Hidden</span>
              </FilterChip>
            </>
          )}
          {shows('fromPlatform') && (
            <FilterChip
              checked={mergedFilters.fromPlatform}
              onChange={(checked) => handleChange({ fromPlatform: checked })}
            >
              <span>Made On-site</span>
            </FilterChip>
          )}
          {currentUser && !isModerator && shows('scheduled') && (
            <FilterChip
              checked={!!mergedFilters.scheduled}
              onChange={(checked) => handleChange({ scheduled: checked ? checked : undefined })}
            >
              <Tooltip label="Show your scheduled posts in feeds">
                <span>Scheduled</span>
              </Tooltip>
            </FilterChip>
          )}
          {/* A Hat Turf sort and My live hats hydrate through the database, which has no remix filter. */}
          {shows('nonRemixesOnly') && !turfHydrated && (
            <FilterChip
              checked={mergedFilters.nonRemixesOnly}
              onChange={(checked) => {
                handleChange({ nonRemixesOnly: checked, remixesOnly: checked ? false : undefined });
              }}
            >
              <span>Originals Only</span>
            </FilterChip>
          )}
          {shows('remixesOnly') && !turfHydrated && (
            <FilterChip
              checked={mergedFilters.remixesOnly}
              onChange={(checked) =>
                handleChange({ remixesOnly: checked, nonRemixesOnly: checked ? false : undefined })
              }
            >
              <span>Remixes Only</span>
            </FilterChip>
          )}
          {showChallengeToggle && shows('hideChallenges') && (
            <FilterChip
              checked={mergedFilters.hideChallenges}
              onChange={(checked) => handleChange({ hideChallenges: checked })}
            >
              <Tooltip label="Hide entries submitted to daily challenges">
                <span>Hide challenge entries</span>
              </Tooltip>
            </FilterChip>
          )}
        </div>

        {showTurf && (
          <>
            <Divider
              label={
                <span className="inline-flex items-center gap-1">
                  <HatIcon size={14} /> Turf filters
                </span>
              }
              className="text-sm font-bold"
              mb={4}
            />
            <Group gap={8} role="group" aria-label="Only">
              <span className="text-dimmed text-xs">Only</span>
              <FilterChip
                checked={myHats}
                onChange={(checked) => handleChange({ hatTurfMine: checked ? true : undefined })}
              >
                <span>My live hats</span>
              </FilterChip>
            </Group>
            {hatSorted && (
              <Chip.Group
                value={mergedFilters.hatTeams ?? []}
                onChange={(hatTeams) => handleChange({ hatTeams })}
                multiple
              >
                <Group gap={8} role="group" aria-label="Teams">
                  <span className="text-dimmed text-xs">Teams</span>
                  {turfPlayer.teams.map((team) => (
                    <FilterChip
                      key={team}
                      value={team}
                      style={{ '--mantine-primary-color-filled': teamColor(team) } as never}
                    >
                      <span>{team}</span>
                    </FilterChip>
                  ))}
                </Group>
              </Chip.Group>
            )}
            <Group gap={8} role="group" aria-label="Show">
              <span className="text-dimmed text-xs">Show</span>
              <Tooltip
                label="Hat Turf sorts and your live hats only list images with Turf hats"
                disabled={!turfHydrated}
              >
                <span>
                  <FilterChip
                    checked={turfHydrated || !mergedFilters.hideTurfHats}
                    disabled={turfHydrated}
                    onChange={(checked) =>
                      handleChange({ hideTurfHats: checked ? undefined : true })
                    }
                  >
                    <span>Turf hats</span>
                  </FilterChip>
                </span>
              </Tooltip>
              <FilterChip
                checked={!mergedFilters.hideWornHats}
                onChange={(checked) => handleChange({ hideWornHats: checked ? undefined : true })}
              >
                <span>Worn hats</span>
              </FilterChip>
            </Group>
          </>
        )}

        {filterType === 'modelImages' && showResources && (
          <>
            <Divider label="Resources" className="text-sm font-bold" mb={4} />
            <div className="flex gap-2">
              {shows('hideManualResources') && (
                <FilterChip
                  checked={mergedFilters.hideManualResources}
                  onChange={(checked) => handleChange({ hideManualResources: checked })}
                >
                  <span>Hide manually-added</span>
                </FilterChip>
              )}
              {shows('hideAutoResources') && (
                <FilterChip
                  checked={mergedFilters.hideAutoResources}
                  onChange={(checked) => handleChange({ hideAutoResources: checked })}
                >
                  <span>Hide auto-detected</span>
                </FilterChip>
              )}
            </div>
          </>
        )}

        {isModerator && showModerator && (
          <>
            <Divider label="Moderator" className="text-sm font-bold" mb={4} />
            <div className="flex flex-wrap gap-2">
              {shows('poiOnly') && (
                <FilterChip
                  checked={mergedFilters.poiOnly}
                  onChange={(checked) => handleChange({ poiOnly: checked })}
                >
                  <span>POI</span>
                </FilterChip>
              )}
              {shows('minorOnly') && (
                <FilterChip
                  checked={mergedFilters.minorOnly}
                  onChange={(checked) => handleChange({ minorOnly: checked })}
                >
                  <span>Minor</span>
                </FilterChip>
              )}
              {shows('disablePoi') && (
                <FilterChip
                  checked={mergedFilters.disablePoi}
                  onChange={(checked) => handleChange({ disablePoi: checked })}
                >
                  <span>Disable POI</span>
                </FilterChip>
              )}
              {shows('disableMinor') && (
                <FilterChip
                  checked={mergedFilters.disableMinor}
                  onChange={(checked) => handleChange({ disableMinor: checked })}
                >
                  <span>Disable Minor</span>
                </FilterChip>
              )}
              {shows('notPublished') && (
                <FilterChip
                  checked={!!mergedFilters.notPublished}
                  onChange={(checked) =>
                    handleChange({ notPublished: checked ? checked : undefined })
                  }
                >
                  <span>Not Published</span>
                </FilterChip>
              )}
              {shows('scheduled') && (
                <FilterChip
                  checked={!!mergedFilters.scheduled}
                  onChange={(checked) => handleChange({ scheduled: checked ? checked : undefined })}
                >
                  <span>Scheduled</span>
                </FilterChip>
              )}
            </div>
          </>
        )}

        {shows('baseModels') && (
          <>
            <Divider label="Base model" className="text-sm font-bold" mb={4} />
            <BaseModelFilterSelect
              value={mergedFilters.baseModels ?? []}
              onChange={(baseModels) => handleChange({ baseModels })}
            />
          </>
        )}

        {shows('tools') && (
          <>
            <Divider label="Tools" className="text-sm font-bold" mb={4} />
            <ToolMultiSelect
              value={mergedFilters.tools ?? []}
              onChange={(tools) => handleChange({ tools })}
              placeholder="Created with..."
              searchable={!isMobileDevice()}
              comboboxProps={{ withinPortal: false }}
            />
          </>
        )}

        {shows('techniques') && (
          <>
            <Divider label="Techniques" className="text-sm font-bold" mb={4} />
            <TechniqueMultiSelect
              value={mergedFilters.techniques ?? []}
              onChange={(techniques) => handleChange({ techniques })}
              placeholder="Created with..."
              searchable={!isMobileDevice()}
              comboboxProps={{ withinPortal: false }}
            />
          </>
        )}
      </Stack>
      {unavailable && greyed.length > 0 && (
        <Stack gap={4} className="opacity-60" aria-disabled>
          <Divider label={unavailable.title} className="text-sm font-bold" mb={4} />
          <Text size="xs" c="dimmed">
            {unavailable.reason}
          </Text>
          <div className="flex flex-wrap gap-2">
            {greyed.map((key) => (
              <FilterChip key={key} checked={false} disabled>
                <span>{unavailable.labels[key]}</span>
              </FilterChip>
            ))}
          </div>
        </Stack>
      )}
    </Stack>
  );

  const dropdownFooter = (
    <StagedFiltersFooter
      isDirty={isDirty}
      onApply={apply}
      onReset={reset}
      filterLength={filterLength}
      onClear={clearAndClose}
    />
  );

  if (mobile)
    return (
      <>
        {target}
        <Drawer
          opened={opened}
          onClose={close}
          size="90%"
          position="bottom"
          styles={{
            content: {
              maxHeight: 'calc(100dvh - var(--header-height))',
              display: 'flex',
              flexDirection: 'column',
            },
            body: {
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              flex: 1,
              minHeight: 0,
            },
            header: { padding: '4px 8px' },
            close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">{dropdownBody}</div>
          {dropdownFooter}
        </Drawer>
      </>
    );

  return (
    <Popover
      zIndex={200}
      position="bottom-end"
      shadow="md"
      radius={12}
      opened={opened}
      onClose={close}
      onChange={(next) => {
        if (!next) close();
      }}
      middlewares={{ flip: true, shift: true }}
      withinPortal
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p={0} w="100%">
        <ScrollArea.Autosize type="hover" mah={'calc(90vh - var(--header-height) - 156px)'}>
          {dropdownBody}
        </ScrollArea.Autosize>
        {dropdownFooter}
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  query?: Partial<GetInfiniteImagesOutput>;
  onChange?: (params: Partial<GetInfiniteImagesOutput>) => void;
  isFeed?: boolean;
  isSameUser?: boolean;
  filterType?: 'images' | 'videos' | 'modelImages';
  hideBaseModels?: boolean;
  hideMediaTypes?: boolean;
  hideTools?: boolean;
  /** Controls this caller cannot honour. Omitted keys render as usual. */
  exclude?: MediaFilterKey[];
  /** Controls shown greyed in their own section, with the reason, instead of in place. */
  unavailable?: {
    title: string;
    reason: string;
    keys: readonly MediaFilterKey[];
    labels: Record<MediaFilterKey, string>;
  };
  /** Offer the jump-to-month control; it only applies while this is a chronological sort. */
  jumpToSort?: string;
};
