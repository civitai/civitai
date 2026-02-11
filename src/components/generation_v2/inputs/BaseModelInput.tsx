/**
 * BaseModelInput
 *
 * A form input component for selecting the base model group for generation.
 * Uses Popover on desktop and dialogStore modal on mobile.
 * When the base model changes, it notifies the ResourceDataProvider to
 * re-evaluate resource compatibility.
 */

import { Group, Modal, Popover, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure, useLocalStorage, useMediaQuery } from '@mantine/hooks';
import { IconCheck, IconChevronDown, IconArrowRight } from '@tabler/icons-react';
import clsx from 'clsx';
import { forwardRef, useCallback, useEffect, useMemo } from 'react';

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
}

function BaseModelListContent({
  value,
  recentItems,
  groupedByFamily,
  getTargetWorkflow,
  onSelect,
  hasIncompatibleItems,
  activeTab,
  onTabChange,
  showRecentTab,
}: BaseModelListContentProps) {
  // Filter grouped items based on active tab
  const filteredGroups = useMemo(() => {
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
  }, [groupedByFamily, activeTab]);

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

  return (
    <Stack gap="md">
      {/* Tab header */}
      {tabs.length > 1 && (
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

      {/* Recent tab content */}
      {activeTab === 'recent' && recentItems.length > 0 && (
        <Stack gap={0}>
          {recentItems.map((item) => {
            const isSelected = value === item.key;
            const button = (
              <UnstyledButton
                key={item.key}
                onClick={() => onSelect(item.key)}
                className={clsx(
                  'flex w-full items-center justify-between rounded px-3 py-2 transition-colors',
                  isSelected
                    ? 'bg-blue-0 dark:bg-blue-9/20'
                    : 'hover:bg-gray-1 dark:hover:bg-dark-5',
                  !item.compatible && 'opacity-60'
                )}
              >
                <div className="flex-1">
                  <Text size="sm" fw={isSelected ? 600 : 400}>
                    {item.name}
                  </Text>
                  {item.description && (
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {item.description}
                    </Text>
                  )}
                </div>
                {isSelected && <IconCheck size={16} className="text-blue-6" />}
                {!item.compatible && !isSelected && (
                  <IconArrowRight size={14} className="text-gray-5" />
                )}
              </UnstyledButton>
            );

            // Show tooltip for incompatible ecosystems
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
        <div key={familyGroup.familyId ?? 'standalone'}>
          {/* Family header */}
          <Text size="xs" c="dimmed" fw={600} tt="uppercase" className="mb-2">
            {familyGroup.familyName ?? 'Other'}
          </Text>

          {/* List of ecosystems */}
          <Stack gap={0}>
            {familyGroup.items.map((item) => {
              const isSelected = value === item.key;
              const button = (
                <UnstyledButton
                  key={item.key}
                  onClick={() => onSelect(item.key)}
                  className={clsx(
                    'flex w-full items-center justify-between rounded px-3 py-2 transition-colors',
                    isSelected
                      ? 'bg-blue-0 dark:bg-blue-9/20'
                      : 'hover:bg-gray-1 dark:hover:bg-dark-5',
                    !item.compatible && 'opacity-60'
                  )}
                >
                  <div className="flex-1">
                    <Text size="sm" fw={isSelected ? 600 : 400}>
                      {item.name}
                    </Text>
                    {item.description && (
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {item.description}
                      </Text>
                    )}
                  </div>
                  {isSelected && <IconCheck size={16} className="text-blue-6" />}
                  {!item.compatible && !isSelected && (
                    <IconArrowRight size={14} className="text-gray-5" />
                  )}
                </UnstyledButton>
              );

              // Show tooltip for incompatible ecosystems
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
  getTargetWorkflow,
  onSelect,
  hasIncompatibleItems,
  activeTab,
  onTabChange,
  showRecentTab,
}: BaseModelSelectModalProps) {
  const dialog = useDialogContext();

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
          getTargetWorkflow={getTargetWorkflow}
          onSelect={handleSelect}
          hasIncompatibleItems={hasIncompatibleItems}
          activeTab={activeTab}
          onTabChange={onTabChange}
          showRecentTab={showRecentTab}
        />
      </div>
    </Modal>
  );
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
  const groupedByFamily = useMemo(() => {
    const familyMap = new Map<number | null, EcosystemDisplayItem[]>();

    for (const item of items) {
      const familyId = item.familyId ?? null;
      const existing = familyMap.get(familyId) ?? [];
      familyMap.set(familyId, [...existing, item]);
    }

    const result: FamilyGroup[] = [];

    // Add family groups first
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

    // Add standalone items (no family) at the end
    const standalone = familyMap.get(null) ?? [];
    if (standalone.length) {
      result.push({
        familyId: null,
        familyName: null,
        items: standalone,
      });
    }

    return result;
  }, [items]);

  const handleSelect = (key: string) => {
    // Check if this is a group or ecosystem
    const item = items.find((i) => i.key === key);

    if (item?.type === 'group') {
      // User selected a group - check for last used ecosystem
      const lastUsed = getLastUsedEcosystem(item.key);

      if (lastUsed) {
        // Use the last used ecosystem if it's still in the group
        const lastUsedEco = ecosystemByKey.get(lastUsed);
        if (lastUsedEco && item.ecosystemIds?.includes(lastUsedEco.id)) {
          onChange?.(lastUsed);
          trackRecentSelection(key);
          closePopover();
          return;
        }
      }

      // No last used ecosystem or it's no longer in the group - use default
      const defaultEco = ecosystemById.get(item.defaultEcosystemId!);
      onChange?.(defaultEco!.key);
    } else {
      // User selected standalone ecosystem
      onChange?.(key);
    }

    trackRecentSelection(key);
    closePopover();
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
        getTargetWorkflow,
        hasIncompatibleItems,
        activeTab,
        onTabChange: handleTabChange,
        showRecentTab,
        onSelect: (key: string) => {
          onChange?.(key);
          trackRecentSelection(key);
        },
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
      onChange={(isOpen) => !isOpen && closePopover()}
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
          getTargetWorkflow={getTargetWorkflow}
          onSelect={handleSelect}
          hasIncompatibleItems={hasIncompatibleItems}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          showRecentTab={showRecentTab}
        />
      </Popover.Dropdown>
    </Popover>
  );
}
