/**
 * BaseModelInput
 *
 * A form input component for selecting the base model group for generation.
 * Uses Popover on desktop and dialogStore modal on mobile.
 * When the base model changes, it notifies the ResourceDataProvider to
 * re-evaluate resource compatibility.
 */

import {
  Group,
  Modal,
  Popover,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure, useLocalStorage, useMediaQuery } from '@mantine/hooks';
import { IconCheck, IconChevronDown, IconArrowRight, IconSearch, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import React, { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { dialogStore } from '~/components/Dialog/dialogStore';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  ecosystemByKey,
  ecosystemById,
  ecosystemFamilies,
  getEcosystemGroup,
  getEcosystemDisplayItems,
  type EcosystemDisplayItem,
} from '~/shared/constants/basemodel.constants';
import { getWorkflowsForEcosystem } from '~/shared/data-graph/generation/config/workflows';
import { useEcosystemGroupPreferencesStore } from '~/store/ecosystem-group-preferences.store';

// =============================================================================
// Types
// =============================================================================

export interface BaseModelInputProps {
  value?: string;
  onChange?: (value: string) => void;
  /** Label displayed before the value */
  label?: string;
  /** Compatible ecosystems for the selected workflow (ecosystem keys) */
  compatibleEcosystems?: string[];
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Check if an ecosystem is compatible with the current workflow */
  isCompatible?: (ecosystemKey: string) => boolean;
  /** Get the target workflow label for an incompatible ecosystem */
  getTargetWorkflow?: (ecosystemKey: string) => string;
  /** Current output type - only ecosystems supporting this type will be shown */
  outputType?: 'image' | 'video';
}

type FamilyGroup = {
  familyId: number | null;
  familyName: string | null;
  items: EcosystemDisplayItem[]; // Changed from EcosystemItem
};

// =============================================================================
// Constants
// =============================================================================

const RECENT_ECOSYSTEMS_KEY = 'generation-recent-ecosystems';
const TAB_PREFERENCE_KEY = 'generation-basemodel-tab';

type TabValue = 'compatible' | 'recent' | 'all';

// =============================================================================
// Trigger Button
// =============================================================================

interface TriggerButtonProps {
  label: string;
  disabled?: boolean;
  opened?: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

const TriggerButton = forwardRef<HTMLButtonElement, TriggerButtonProps>(
  ({ label, disabled, opened, onClick, onMouseEnter, onMouseLeave }, ref) => {
    return (
      <UnstyledButton
        ref={ref}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        disabled={disabled}
        className={clsx(
          'relative flex min-w-0 items-center gap-1.5 rounded-md border px-3 py-1.5 transition-colors',
          'border-gray-3 bg-white text-gray-7 hover:border-blue-3',
          'dark:border-dark-4 dark:bg-dark-6 dark:text-gray-3 dark:hover:border-dark-3',
          disabled && 'cursor-not-allowed opacity-50',
          opened &&
            'ring-2 ring-blue-5/20 after:absolute after:-bottom-2 after:left-0 after:h-2 after:w-full'
        )}
      >
        <Text size="sm" fw={500} className="min-w-0 truncate">
          {label}
        </Text>
        <IconChevronDown
          size={14}
          className={clsx('shrink-0 text-gray-5 transition-transform', opened && 'rotate-180')}
        />
      </UnstyledButton>
    );
  }
);

TriggerButton.displayName = 'TriggerButton';

// =============================================================================
// List Content (shared between Popover and Modal)
// =============================================================================

interface BaseModelListContentProps {
  value?: string;
  recentItems: EcosystemDisplayItem[];
  groupedByFamily: FamilyGroup[];
  /** All items grouped by family (no outputType filter) for search */
  allGroupedByFamily: FamilyGroup[];
  /** Get the target workflow label for an incompatible ecosystem */
  getTargetWorkflow?: (ecosystemKey: string) => string;
  onSelect: (key: string) => void;
  /** Whether there are any incompatible items */
  hasIncompatibleItems?: boolean;
  /** Current tab */
  activeTab: TabValue;
  /** Tab change handler */
  onTabChange: (tab: TabValue) => void;
  /** Whether the recent tab should be available */
  showRecentTab: boolean;
  /** Whether to auto-focus the search input */
  autoFocusSearch?: boolean;
  /** Callback when search value changes (for parent to clear on close) */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
}

function BaseModelListContent({
  value,
  recentItems,
  groupedByFamily,
  allGroupedByFamily,
  getTargetWorkflow,
  onSelect,
  hasIncompatibleItems,
  activeTab,
  onTabChange,
  showRecentTab,
  autoFocusSearch,
  searchValue = '',
  onSearchChange,
}: BaseModelListContentProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isSearching = searchValue.length > 0;
  const [activeIndex, setActiveIndex] = useState(-1);

  // Auto-focus search input when requested
  useEffect(() => {
    if (autoFocusSearch) {
      // Small delay to ensure the input is mounted
      const timer = setTimeout(() => searchRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [autoFocusSearch]);

  // Filter grouped items based on active tab and search query
  const filteredGroups = useMemo(() => {
    const filterBySearch = (items: EcosystemDisplayItem[]) => {
      if (!isSearching) return items;
      const query = searchValue.toLowerCase();
      return items.filter(
        (item) => item.name.toLowerCase().includes(query) || item.key.toLowerCase().includes(query)
      );
    };

    // When searching, show all items (including other output types) regardless of tab
    if (isSearching) {
      return allGroupedByFamily
        .map((group) => ({
          ...group,
          items: filterBySearch(group.items),
        }))
        .filter((group) => group.items.length > 0);
    }

    if (activeTab === 'all') return groupedByFamily;

    if (activeTab === 'recent') {
      // For recent tab, show only the recent items (flat list, no grouping)
      return [];
    }

    // Compatible tab: filter to compatible items only
    return groupedByFamily
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => item.compatible),
      }))
      .filter((group) => group.items.length > 0);
  }, [groupedByFamily, activeTab, isSearching, searchValue]);

  // Build available tabs
  const tabs: { value: TabValue; label: string }[] = useMemo(() => {
    const result: { value: TabValue; label: string }[] = [
      { value: 'compatible', label: 'Workflow Compatible' },
    ];
    if (showRecentTab) {
      result.push({ value: 'recent', label: 'Recent' });
    }
    if (hasIncompatibleItems) {
      result.push({ value: 'all', label: 'All' });
    }
    return result;
  }, [showRecentTab, hasIncompatibleItems]);

  // Filter recent items by search
  const filteredRecentItems = useMemo(() => {
    if (!isSearching) return recentItems;
    const query = searchValue.toLowerCase();
    return recentItems.filter(
      (item) => item.name.toLowerCase().includes(query) || item.key.toLowerCase().includes(query)
    );
  }, [recentItems, isSearching, searchValue]);

  // Flat ordered list of visible items for keyboard navigation
  const flatItems = useMemo(() => {
    if (activeTab === 'recent' && !isSearching) return filteredRecentItems;
    return filteredGroups.flatMap((g) => g.items);
  }, [activeTab, isSearching, filteredRecentItems, filteredGroups]);

  // Reset keyboard focus when content changes
  useEffect(() => {
    setActiveIndex(-1);
  }, [searchValue, activeTab]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector('[data-keyboard-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const activeItemKey = activeIndex >= 0 ? flatItems[activeIndex]?.key : undefined;

  const handleSearchKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (flatItems.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, flatItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, -1));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      const item = flatItems[activeIndex];
      if (item) onSelect(item.key);
    }
  };

  // Check if search has no results
  const hasNoResults =
    isSearching && filteredGroups.length === 0 && filteredRecentItems.length === 0;

  return (
    <Stack gap="md">
      {/* Search input */}
      <TextInput
        ref={searchRef}
        value={searchValue}
        onChange={(e) => onSearchChange?.(e.currentTarget.value)}
        onKeyDown={handleSearchKeyDown}
        placeholder="Search ecosystems..."
        size="sm"
        leftSection={<IconSearch size={14} />}
        rightSection={
          isSearching ? (
            <UnstyledButton onClick={() => onSearchChange?.('')} className="flex items-center">
              <IconX size={14} className="text-gray-5" />
            </UnstyledButton>
          ) : null
        }
      />

      {/* Tab header - hidden while searching */}
      {tabs.length > 1 && !isSearching && (
        <Group gap="xs">
          {tabs.map((tab) => (
            <UnstyledButton
              key={tab.value}
              onClick={() => onTabChange(tab.value)}
              className={clsx(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                activeTab === tab.value
                  ? 'bg-blue-1 text-blue-7 dark:bg-blue-9/30 dark:text-blue-4'
                  : 'text-gray-6 hover:bg-gray-1 dark:text-gray-4 dark:hover:bg-dark-5'
              )}
            >
              {tab.label}
            </UnstyledButton>
          ))}
        </Group>
      )}

      {/* No results message */}
      {hasNoResults && (
        <Text size="sm" c="dimmed" ta="center" py="md">
          No ecosystems match &ldquo;{searchValue}&rdquo;
        </Text>
      )}

      {/* Scrollable item list */}
      <div ref={listRef}>
        {/* Recent tab content - hidden while searching since grouped results cover all items */}
        {activeTab === 'recent' && !isSearching && filteredRecentItems.length > 0 && (
          <Stack gap={0}>
            {filteredRecentItems.map((item) => {
              const isSelected = value === item.key;
              const isActive = item.key === activeItemKey;
              const button = (
                <UnstyledButton
                  key={item.key}
                  data-keyboard-active={isActive ? 'true' : undefined}
                  onClick={() => onSelect(item.key)}
                  className={clsx(
                    'flex w-full items-center justify-between rounded px-3 py-2 transition-colors',
                    isSelected
                      ? 'bg-blue-0 dark:bg-blue-9/20'
                      : isActive
                        ? 'bg-gray-1 dark:bg-dark-5'
                        : 'hover:bg-gray-1 dark:hover:bg-dark-5',
                    !item.compatible && 'opacity-60'
                  )}
                >
                  <div className="flex-1">
                    <Text size="sm" fw={isSelected ? 600 : 400}>
                      {item.name}
                    </Text>
                  </div>
                  {isSelected && <IconCheck size={16} className="text-blue-6" />}
                  {!item.compatible && !isSelected && (
                    <IconArrowRight size={14} className="text-gray-5" />
                  )}
                </UnstyledButton>
              );

              if (!item.compatible && getTargetWorkflow) {
                return (
                  <Tooltip
                    key={item.key}
                    label={`Will switch to ${getTargetWorkflow(item.key)}`}
                    position="right"
                    withArrow
                    openDelay={300}
                  >
                    {button}
                  </Tooltip>
                );
              }

              return button;
            })}
          </Stack>
        )}

        {/* Grouped models (for compatible and all tabs) */}
        {filteredGroups.map((familyGroup) => (
          <div key={familyGroup.familyId ?? 'standalone'} className="mb-4 last:mb-0">
            <Text size="xs" c="dimmed" fw={600} tt="uppercase" className="mb-2">
              {familyGroup.familyName ?? 'Other'}
            </Text>
            <Stack gap={0}>
              {familyGroup.items.map((item) => {
                const isSelected = value === item.key;
                const isActive = item.key === activeItemKey;
                const button = (
                  <UnstyledButton
                    key={item.key}
                    data-keyboard-active={isActive ? 'true' : undefined}
                    onClick={() => onSelect(item.key)}
                    className={clsx(
                      'flex w-full items-center justify-between rounded px-3 py-2 transition-colors',
                      isSelected
                        ? 'bg-blue-0 dark:bg-blue-9/20'
                        : isActive
                          ? 'bg-gray-1 dark:bg-dark-5'
                          : 'hover:bg-gray-1 dark:hover:bg-dark-5',
                      !item.compatible && 'opacity-60'
                    )}
                  >
                    <div className="flex-1">
                      <Text size="sm" fw={isSelected ? 600 : 400}>
                        {item.name}
                      </Text>
                    </div>
                    {isSelected && <IconCheck size={16} className="text-blue-6" />}
                    {!item.compatible && !isSelected && (
                      <IconArrowRight size={14} className="text-gray-5" />
                    )}
                  </UnstyledButton>
                );

                if (!item.compatible && getTargetWorkflow) {
                  return (
                    <Tooltip
                      key={item.key}
                      label={`Will switch to ${getTargetWorkflow(item.key)}`}
                      position="right"
                      withArrow
                      openDelay={300}
                    >
                      {button}
                    </Tooltip>
                  );
                }

                return button;
              })}
            </Stack>
          </div>
        ))}
      </div>
    </Stack>
  );
}

// =============================================================================
// Mobile Modal Component (for dialogStore)
// =============================================================================

interface BaseModelSelectModalProps {
  value?: string;
  recentItems: EcosystemDisplayItem[];
  groupedByFamily: FamilyGroup[];
  allGroupedByFamily: FamilyGroup[];
  /** Get the target workflow label for an incompatible ecosystem */
  getTargetWorkflow?: (ecosystemKey: string) => string;
  onSelect: (key: string) => void;
  hasIncompatibleItems?: boolean;
  activeTab: TabValue;
  onTabChange: (tab: TabValue) => void;
  showRecentTab: boolean;
}

function BaseModelSelectModal({
  value,
  recentItems,
  groupedByFamily,
  allGroupedByFamily,
  getTargetWorkflow,
  onSelect,
  hasIncompatibleItems,
  activeTab: initialTab,
  onTabChange,
  showRecentTab,
}: BaseModelSelectModalProps) {
  const dialog = useDialogContext();
  const [searchValue, setSearchValue] = useState('');
  // Local tab state so switching works within the modal (dialogStore props are snapshots)
  const [localTab, setLocalTab] = useState<TabValue>(initialTab);

  const handleTabChange = (tab: TabValue) => {
    setLocalTab(tab);
    onTabChange(tab); // persist preference
  };

  const handleSelect = (key: string) => {
    onSelect(key);
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      onClose={dialog.onClose}
      title="Select Base Model"
      fullScreen
      styles={{
        header: {
          borderBottom: '1px solid var(--mantine-color-default-border)',
        },
      }}
    >
      <div className="pt-4">
        <BaseModelListContent
          value={value}
          recentItems={recentItems}
          groupedByFamily={groupedByFamily}
          allGroupedByFamily={allGroupedByFamily}
          getTargetWorkflow={getTargetWorkflow}
          onSelect={handleSelect}
          hasIncompatibleItems={hasIncompatibleItems}
          activeTab={localTab}
          onTabChange={handleTabChange}
          showRecentTab={showRecentTab}
          autoFocusSearch
          searchValue={searchValue}
          onSearchChange={setSearchValue}
        />
      </div>
    </Modal>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function groupItemsByFamily(items: EcosystemDisplayItem[]): FamilyGroup[] {
  const familyMap = new Map<number | null, EcosystemDisplayItem[]>();

  for (const item of items) {
    const familyId = item.familyId ?? null;
    const existing = familyMap.get(familyId) ?? [];
    familyMap.set(familyId, [...existing, item]);
  }

  const result: FamilyGroup[] = [];

  const families = [...familyMap.entries()]
    .filter(([familyId]) => familyId !== null)
    .sort(([a], [b]) => {
      const nameA = ecosystemFamilies.find((f) => f.id === a)?.name ?? '';
      const nameB = ecosystemFamilies.find((f) => f.id === b)?.name ?? '';
      return nameA.localeCompare(nameB);
    });

  for (const [familyId, familyItems] of families) {
    const family = ecosystemFamilies.find((f) => f.id === familyId);
    result.push({
      familyId,
      familyName: family?.name ?? null,
      items: familyItems,
    });
  }

  const standalone = familyMap.get(null) ?? [];
  if (standalone.length) {
    result.push({
      familyId: null,
      familyName: null,
      items: standalone,
    });
  }

  return result;
}

// =============================================================================
// Component
// =============================================================================

export function BaseModelInput({
  value,
  onChange,
  compatibleEcosystems,
  disabled,
  isCompatible,
  getTargetWorkflow,
  outputType,
}: BaseModelInputProps) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [popoverOpened, { close: closePopover, open: openPopover }] = useDisclosure(false);
  const [searchValue, setSearchValue] = useState('');
  const [recentEcosystems, setRecentEcosystems] = useLocalStorage<string[]>({
    key: RECENT_ECOSYSTEMS_KEY,
    defaultValue: [],
  });
  const [storedTab, setStoredTab] = useLocalStorage<TabValue>({
    key: TAB_PREFERENCE_KEY,
    defaultValue: 'compatible',
  });

  // Get/set last used ecosystem for groups
  const getLastUsedEcosystem = useEcosystemGroupPreferencesStore(
    (state) => state.getLastUsedEcosystem
  );
  const setLastUsedEcosystem = useEcosystemGroupPreferencesStore(
    (state) => state.setLastUsedEcosystem
  );

  // Track selection in recent ecosystems (keeps all unique selections, most recent first)
  const trackRecentSelection = useCallback(
    (ecosystem: string) => {
      setRecentEcosystems((prev) => {
        const filtered = prev.filter((e) => e !== ecosystem);
        return [ecosystem, ...filtered];
      });
    },
    [setRecentEcosystems]
  );

  // Get display items: groups and standalone ecosystems
  const items = useMemo((): EcosystemDisplayItem[] => {
    return getEcosystemDisplayItems({
      compatibleEcosystems,
      isCompatible,
      outputType,
    });
  }, [compatibleEcosystems, isCompatible, outputType]);

  // Get ALL items (no outputType filter) for search across all ecosystems.
  // Filters out ecosystems/groups that don't have any dedicated workflows.
  const allItems = useMemo((): EcosystemDisplayItem[] => {
    const all = getEcosystemDisplayItems({
      compatibleEcosystems,
      isCompatible,
    });

    return all.filter((item) => {
      if (item.type === 'group' && item.ecosystemIds) {
        // Group: at least one ecosystem in the group must have a dedicated workflow
        return item.ecosystemIds.some((id) =>
          getWorkflowsForEcosystem(id).some((w) => w.ecosystemIds.includes(id))
        );
      }

      // Standalone ecosystem: must have a dedicated workflow
      const eco = ecosystemByKey.get(item.key);
      if (!eco) return false;
      return getWorkflowsForEcosystem(eco.id).some((w) => w.ecosystemIds.includes(eco.id));
    });
  }, [compatibleEcosystems, isCompatible]);

  // Check if there are any incompatible items (to show the toggle)
  const hasIncompatibleItems = useMemo(() => {
    return items.some((item) => !item.compatible);
  }, [items]);

  // Track when value changes - update last used ecosystem for groups
  useEffect(() => {
    if (!value) return;

    const eco = ecosystemByKey.get(value);
    if (!eco) return;

    const group = getEcosystemGroup(eco.id);
    if (group) {
      // This ecosystem is part of a group - track it
      setLastUsedEcosystem(group.id, value);
    }
  }, [value, setLastUsedEcosystem]);

  // Get readable name for current value
  const readableName = useMemo(() => {
    if (!value) return 'Select';

    const eco = ecosystemByKey.get(value);
    if (!eco) return value;

    // Check if this ecosystem is in a group
    const group = getEcosystemGroup(eco.id);
    return group ? group.displayName : eco.displayName;
  }, [value]);

  // Group items by family
  const groupedByFamily = useMemo(() => groupItemsByFamily(items), [items]);

  // Group all items by family (for search across all ecosystems)
  const allGroupedByFamily = useMemo(() => groupItemsByFamily(allItems), [allItems]);

  const handleSelect = (key: string) => {
    // Search results may come from allItems (cross-output-type), so check both
    const item = items.find((i) => i.key === key) ?? allItems.find((i) => i.key === key);

    if (item?.type === 'group') {
      // Resolve group to an actual ecosystem:
      // 1. Last used (if still in group AND compatible with current workflow)
      // 2. Default ecosystem from group config
      // 3. First compatible ecosystem in the group
      const ids = item.ecosystemIds ?? [];
      const lastUsed = getLastUsedEcosystem(item.key);
      if (lastUsed) {
        const lastUsedEco = ecosystemByKey.get(lastUsed);
        if (
          lastUsedEco &&
          ids.includes(lastUsedEco.id) &&
          (!isCompatible || isCompatible(lastUsed))
        ) {
          onChange?.(lastUsed);
          trackRecentSelection(key);
          closePopover();
          setSearchValue('');
          return;
        }
      }

      // Try default ecosystem
      const defaultEco = ecosystemById.get(item.defaultEcosystemId!);
      if (defaultEco && (!isCompatible || isCompatible(defaultEco.key))) {
        onChange?.(defaultEco.key);
      } else {
        // Default not compatible — find first compatible ecosystem in the group
        const compatibleEco = ids
          .map((id) => ecosystemById.get(id))
          .find((eco) => eco && isCompatible?.(eco.key));
        onChange?.(compatibleEco?.key ?? defaultEco?.key ?? key);
      }
    } else {
      onChange?.(key);
    }

    trackRecentSelection(key);
    closePopover();
    setSearchValue('');
  };

  // Get recent items - resolve recent keys to current display items
  const recentItems = useMemo(() => {
    return recentEcosystems
      .map((key) => items.find((item) => item.key === key))
      .filter((item): item is EcosystemDisplayItem => item !== undefined);
  }, [recentEcosystems, items]);

  // Show recent tab only if there are recent items that don't match the current selection
  const showRecentTab = useMemo(() => {
    return recentItems.some((item) => item.key !== value);
  }, [recentItems, value]);

  // Compute active tab - default to 'compatible' if stored tab isn't available
  const activeTab = useMemo((): TabValue => {
    if (storedTab === 'recent' && !showRecentTab) return 'compatible';
    if (storedTab === 'all' && !hasIncompatibleItems) return 'compatible';
    return storedTab;
  }, [storedTab, showRecentTab, hasIncompatibleItems]);

  const handleTabChange = useCallback(
    (tab: TabValue) => {
      setStoredTab(tab);
    },
    [setStoredTab]
  );

  const openMobileModal = () => {
    dialogStore.trigger({
      id: 'basemodel-select',
      component: BaseModelSelectModal,
      props: {
        value,
        recentItems,
        groupedByFamily,
        allGroupedByFamily,
        getTargetWorkflow,
        hasIncompatibleItems,
        activeTab,
        onTabChange: handleTabChange,
        showRecentTab,
        onSelect: handleSelect,
      },
    });
  };

  // Mobile: use dialogStore modal
  if (isMobile) {
    return (
      <TriggerButton
        label={readableName}
        disabled={disabled}
        opened={false}
        onClick={openMobileModal}
      />
    );
  }

  // Desktop: use Popover with hover
  const handleMouseEnter = () => {
    if (!disabled) {
      openPopover();
    }
  };

  return (
    <Popover
      opened={popoverOpened}
      onChange={(isOpen) => {
        if (!isOpen) {
          closePopover();
          setSearchValue('');
        }
      }}
      position="bottom-start"
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <TriggerButton
          label={readableName}
          disabled={disabled}
          opened={popoverOpened}
          onClick={() => undefined}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={closePopover}
        />
      </Popover.Target>
      <Popover.Dropdown
        p="sm"
        className="max-h-[70vh] min-w-[280px] overflow-y-auto before:absolute before:-top-2 before:left-0 before:h-2 before:w-full"
        onMouseEnter={openPopover}
        onMouseLeave={closePopover}
      >
        <BaseModelListContent
          value={value}
          recentItems={recentItems}
          groupedByFamily={groupedByFamily}
          allGroupedByFamily={allGroupedByFamily}
          getTargetWorkflow={getTargetWorkflow}
          onSelect={handleSelect}
          hasIncompatibleItems={hasIncompatibleItems}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          showRecentTab={showRecentTab}
          searchValue={searchValue}
          onSearchChange={setSearchValue}
        />
      </Popover.Dropdown>
    </Popover>
  );
}
