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
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useHideOnScroll } from '~/hooks/useHideOnScroll';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CategoryTagFilters } from './CategoryTagFilters';
import { ResourceHitList } from './ResourceHitList';
import { ResourceLookupResult } from './ResourceLookupResult';
import { parseResourceLookup } from '~/components/ImageGeneration/GenerationForm/resource-lookup';

/** Each role says what it is and what it is judged against. */
const ROLE_COPY = {
  resource: {
    title: 'Add resources',
    subtitle: 'LoRAs, embeddings and VAEs layered on your checkpoint',
  },
} as const;

export function ResourceSelectModalContent() {
  const { title, onClose, selectSource, tab, setTab, role, resources } = useResourceSelectContext();
  const dialog = useDialogContext();
  const isMobile = useIsMobile({ type: 'media' });
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  const [search, setSearch] = useState('');
  const resultsRef = useRef<HTMLDivElement>(null);
  const [toolbarFocused, setToolbarFocused] = useState(false);
  const scrolledDown = useHideOnScroll(resultsRef, { resetKey: tab });
  const toolbarHidden = isMobile && scrolledDown && !toolbarFocused;
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const pasted = useMemo(() => parseResourceLookup(debouncedSearch), [debouncedSearch]);

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

      <div className="flex min-h-0 min-w-0 flex-1">
        {/* `min-w-0` is load-bearing: a flex item defaults to `min-width: auto`,
            which refuses to shrink below its content's intrinsic width. The
            catalog's toolbar and grid are intrinsically wide, so without this
            the whole column — not any one element in it — spills past the
            modal's right edge on a narrow viewport. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* `overflow-y-scroll`, not `auto`: the gutter is reserved whether or
              not the catalog overflows. At the threshold — a result set just
              tall enough to need a scrollbar — `auto` toggles it on and off,
              which changes the pane width, which re-flows the grid, which
              changes the height again. */}
          <div ref={resultsRef} className="flex min-h-0 flex-1 flex-col">
            <ScrollArea
              id="resource-select-modal"
              scrollRestore={{ key: 'resource-select-modal', enabled: false }}
              className="flex-1 overflow-y-scroll"
            >
              {/* Sticky over the results; on a phone it slides away while they scroll down. */}
              <div
                className="sticky top-0 z-10 flex-none border-b border-gray-3 bg-[var(--mantine-color-body)] transition-transform duration-200 dark:border-dark-4"
                style={toolbarHidden ? { transform: 'translateY(-100%)' } : undefined}
                onFocus={() => setToolbarFocused(true)}
                onBlur={(e) => setToolbarFocused(e.currentTarget.contains(e.relatedTarget))}
              >
                <div className="flex flex-col gap-2.5 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <CatalogTabs tabs={allowedTabs} value={tab} onChange={setTab} />
                    {/* A row of its own on a phone, so the search gets the width. */}
                    <div className="flex min-w-0 grow basis-full items-center gap-2 sm:basis-80">
                      <TextInput
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        leftSection={<IconSearch size={16} />}
                        placeholder="Search models or paste a link"
                        // 16px text on a phone, or iOS zooms the page when it takes focus.
                        size={isMobile ? 'md' : 'xs'}
                        className="min-w-0 flex-1"
                        // Autofocus opens the on-screen keyboard over half the catalog
                        // before anything has been browsed.
                        autoFocus={!isMobile}
                        // React's autoFocus alone loses the race: Mantine's focus trap
                        // runs a tick after mount and focuses the first focusable node —
                        // the close button — unless something claims data-autofocus.
                        data-autofocus={!isMobile ? true : undefined}
                      />
                      {tab !== 'featured' && <ResourceSelectSort />}
                      <ResourceSelectFiltersDropdown />
                      <GenerationSettingsPopover>
                        <LegacyActionIcon>
                          <IconSettings />
                        </LegacyActionIcon>
                      </GenerationSettingsPopover>
                    </div>
                  </div>

                  <CategoryTagFilters />
                </div>
              </div>
              {pasted && <ResourceLookupResult lookup={pasted.lookup} />}
              {!pasted?.isLink && <ResourceHitList key={tab} query={debouncedSearch} />}
            </ScrollArea>
          </div>
        </div>
      </div>

      <div className="flex-none">
        <StagedTray />
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
      // Scrolls rather than shrinks: five tabs are wider than a phone, and a
      // `shrink-0` track that cannot wrap pushes the whole toolbar off the
      // right edge instead.
      className="flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-gray-3 bg-gray-1 p-0.5 dark:border-dark-4 dark:bg-dark-6"
    >
      {tabs.map((t) => (
        <UnstyledButton
          key={t}
          aria-pressed={t === value}
          onClick={() => onChange(t)}
          className={clsx(
            'shrink-0 rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider',
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
    <div className="flex flex-wrap items-center gap-3 border-t border-gray-3 bg-gray-0 p-3 dark:border-dark-4 dark:bg-dark-7">
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
