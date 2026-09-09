import { Badge, Button, CloseButton, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import clsx from 'clsx';
import {
  IconBox,
  IconDatabase,
  IconLink,
  IconSearch,
  IconSettings,
  IconStack2,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { GenerationSettingsPopover } from '~/components/Generation/GenerationSettings';
import {
  ResourceSelectFiltersDropdown,
  ResourceSelectSort,
} from '~/components/ImageGeneration/GenerationForm/ResourceSelectFilters';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import {
  resourceSelectTabs,
  type Tabs,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CategoryTagFilters } from './CategoryTagFilters';
import { InlineRail } from './PickerRail';
import { ResourceHitList } from './ResourceHitList';

/** Each role says what it is and what it is judged against. */
const ROLE_COPY = {
  checkpoint: {
    title: 'Select checkpoint',
    subtitle: 'The base model everything else is judged against',
  },
  resource: {
    title: 'Add resources',
    subtitle: 'LoRAs, embeddings and VAEs layered on your checkpoint',
  },
} as const;

export function ResourceSelectModalContent({ Rail }: { Rail?: React.ComponentType }) {
  const {
    title,
    onClose,
    selectSource,
    tab,
    setTab,
    footer: Footer,
    role,
    resources,
    catalogNotice,
  } = useResourceSelectContext();
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  let allowedTabs = resourceSelectTabs.filter((t) => {
    return !(!currentUser && ['recent', 'liked', 'mine'].includes(t));
  });
  if (!features.auctions) {
    allowedTabs = allowedTabs.filter((t) => t !== 'featured');
  }
  // The "Official" tab is the dedup nudge for component linking — surface the
  // CivitaiOfficial canonical resources only in that context, not in generation.
  if (selectSource !== 'modelVersion') {
    allowedTabs = allowedTabs.filter((t) => t !== 'official');
  }

  // A persisted tab can become disallowed (e.g. 'mine' after logout, or 'featured'
  // once auctions are off) — fall back to 'all' so we don't render a phantom tab
  // whose server restriction silently drops.
  useEffect(() => {
    if (!allowedTabs.includes(tab)) setTab('all');
  }, [allowedTabs, tab, setTab]);

  function handleClose() {
    dialog.onClose();
    onClose?.();
  }

  return (
    // Three bands, as the design draws them: the header spans the whole modal,
    // the rail and the catalog sit side by side beneath it, and the footer spans
    // the whole modal again. Only the catalog scrolls — the rail scrolls itself.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2.5 border-b border-gray-3 p-3 dark:border-dark-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gray-2 text-gray-6 dark:bg-dark-5 dark:text-dark-2">
          {role === 'resource' ? <IconStack2 size={19} /> : <IconBox size={19} />}
        </span>
        <div className="min-w-0 flex-1">
          <Text fw={600} className="leading-tight">
            {role ? ROLE_COPY[role].title : title}
          </Text>
          {role && (
            <Text size="xs" c="dimmed" className="leading-tight">
              {ROLE_COPY[role].subtitle}
            </Text>
          )}
        </div>
        {/* What the catalog is scoped to — a filtered list otherwise reads as
            models being missing. Stated once, here, rather than beside the
            search box where it competes with the controls. */}
        {role && (
          <span className="hidden shrink-0 items-center gap-1.5 text-xs text-gray-6 md:flex dark:text-dark-2">
            {role === 'resource' ? (
              <>
                <IconLink size={13} />
                Compatible with your checkpoint
              </>
            ) : (
              <>
                <IconDatabase size={13} />
                {[...new Set(resources.flatMap((r) => r.baseModels))].slice(0, 3).join(', ')}{' '}
                checkpoints
              </>
            )}
          </span>
        )}
        <CloseButton onClick={handleClose} />
      </div>

      <div className="flex min-h-0 flex-1">
        {Rail && <Rail />}

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-none flex-col gap-2.5 p-3">
            <div className={clsx('flex flex-wrap items-center gap-2', !!catalogNotice && 'hidden')}>
              <CatalogTabs tabs={allowedTabs} value={tab} onChange={setTab} />
              {tab !== 'featured' && <ResourceSelectSort />}
              <ResourceSelectFiltersDropdown />
              <GenerationSettingsPopover>
                <LegacyActionIcon>
                  <IconSettings />
                </LegacyActionIcon>
              </GenerationSettingsPopover>
              <TextInput
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                leftSection={<IconSearch size={16} />}
                placeholder="Search models"
                size="xs"
                className="w-full min-w-40 flex-1 sm:w-auto"
                autoFocus
              />
            </div>

            <CategoryTagFilters />

            <MobileRailStep Rail={Rail} />
          </div>

          {/* `overflow-y-scroll`, not `auto`: the gutter is reserved whether or
              not the catalog overflows. At the threshold — a result set just
              tall enough to need a scrollbar — `auto` toggles it on and off,
              which changes the pane width, which re-flows the grid, which
              changes the height again. */}
          <ScrollArea
            id="resource-select-modal"
            scrollRestore={{ key: 'resource-select-modal', enabled: false }}
            className="flex-1 overflow-y-scroll"
          >
            {catalogNotice ? (
              <div className="p-3">{catalogNotice}</div>
            ) : (
              <ResourceHitList key={tab} query={debouncedSearch} />
            )}
          </ScrollArea>
        </div>
      </div>

      <div className="flex-none">
        <StagedTray />
        {Footer && (
          <div className="border-t border-gray-3 dark:border-dark-4">
            <Footer />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The catalog tabs as a compact segmented group — small caps in one bordered
 * track, sized to its labels. Mantine's SegmentedControl stretched to the row
 * and pushed the sort and filter controls onto a line of their own.
 */
function CatalogTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: Tabs[];
  value: Tabs;
  onChange: (tab: Tabs) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Catalog tab"
      className="flex shrink-0 gap-0.5 rounded-lg border border-gray-3 bg-gray-1 p-0.5 dark:border-dark-4 dark:bg-dark-6"
    >
      {tabs.map((t) => (
        <UnstyledButton
          key={t}
          aria-pressed={t === value}
          onClick={() => onChange(t)}
          className={clsx(
            'rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider',
            t === value
              ? 'bg-white text-dark-9 shadow-sm dark:bg-dark-4 dark:text-white'
              : 'text-gray-6 hover:text-gray-9 dark:text-dark-2 dark:hover:text-gray-3',
            t === 'featured' && t !== value && 'text-yellow-7 dark:text-yellow-5'
          )}
        >
          {t}
        </UnstyledButton>
      ))}
    </div>
  );
}

/**
 * The rail's mobile half. A 224px column beside a catalog does not fit in
 * 390px, so below @md the rail collapses to this bar and the picker opens on
 * the CATALOG: swapping within a family is the common move and stays one tap,
 * while changing family — rarer, and destructive — sits one level up.
 */
function MobileRailStep({ Rail }: { Rail?: React.ComponentType }) {
  const [opened, setOpened] = useState(false);
  // The label assumes the rail is the ecosystem one, which is the only rail any
  // caller supplies.
  if (!Rail) return null;

  return (
    <div className="md:hidden">
      {opened ? (
        <div className="rounded-lg border border-gray-3 dark:border-dark-4">
          <div className="flex items-center gap-2 border-b border-gray-3 p-2 dark:border-dark-4">
            <Button variant="subtle" size="compact-sm" onClick={() => setOpened(false)}>
              Back
            </Button>
            <Text size="sm" fw={600}>
              Change model family
            </Text>
          </div>
          <InlineRail>
            <Rail />
          </InlineRail>
        </div>
      ) : (
        <Button variant="default" fullWidth onClick={() => setOpened(true)}>
          Change model family
        </Button>
      )}
    </div>
  );
}

/**
 * Multi-select's commit bar. Strength is deliberately NOT editable here — the
 * form's own resource list already owns it, and a second control for one value
 * is the duplication this picker is being reshaped to remove.
 */
function StagedTray() {
  const { multiSelect, staged, removeStaged, commitStaged, limit } = useResourceSelectContext();
  const dialog = useDialogContext();
  // Only once a batch exists. Standing permanently at the foot of the picker, it
  // implied everyone had to use it — which is what made adding one resource
  // cost two clicks.
  if (!multiSelect || !staged.length) return null;

  return (
    <div className="flex items-center gap-3 border-t border-gray-3 bg-gray-0 p-3 dark:border-dark-4 dark:bg-dark-7">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        {staged.map((resource) => (
          <Badge
            key={resource.id}
            variant="light"
            size="lg"
            className="shrink-0"
            rightSection={
              <CloseButton
                size="xs"
                onClick={() => removeStaged(resource.id)}
                aria-label="Remove"
              />
            }
          >
            {resource.model.name}
          </Badge>
        ))}
      </div>
      <Button variant="default" onClick={dialog.onClose} className="shrink-0">
        Cancel
      </Button>
      <Button onClick={commitStaged} className="shrink-0">
        Add {staged.length} {staged.length === 1 ? 'resource' : 'resources'}
        {limit !== undefined ? ` (${limit} free)` : ''}
      </Button>
    </div>
  );
}
