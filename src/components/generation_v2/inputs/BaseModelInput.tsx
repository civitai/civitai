/**
 * BaseModelInput
 *
 * A form input component for selecting the base model group for generation.
 * Uses Popover on desktop and dialogStore modal on mobile.
 * When the base model changes, it notifies the ResourceDataProvider to
 * re-evaluate resource compatibility.
 */

import {
  Badge,
  Divider,
  Group,
  Modal,
  Popover,
  Stack,
  Switch,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure, useLocalStorage, useMediaQuery } from '@mantine/hooks';
import { IconCheck, IconChevronDown, IconArrowRight } from '@tabler/icons-react';
import { useState } from 'react';
import clsx from 'clsx';
import { forwardRef, useCallback, useMemo } from 'react';

import { dialogStore } from '~/components/Dialog/dialogStore';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  ecosystems,
  ecosystemByKey,
  ecosystemFamilies,
  ecosystemFamilyById,
  getGenerationEcosystemsForMediaType,
} from '~/shared/constants/basemodel.constants';

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
  /** Target workflow label when selecting an incompatible ecosystem */
  targetWorkflow?: string;
  /** Current output type - only ecosystems supporting this type will be shown */
  outputType?: 'image' | 'video';
}

type EcosystemItem = {
  key: string;
  name: string;
  description?: string;
  familyId?: number;
  compatible: boolean;
};

type FamilyGroup = {
  familyId: number | null;
  familyName: string | null;
  items: EcosystemItem[];
};

// =============================================================================
// Constants
// =============================================================================

const RECENT_ECOSYSTEMS_KEY = 'generation-recent-ecosystems';
const MAX_RECENT_DISPLAY = 3;

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
  recentItems: EcosystemItem[];
  groupedByFamily: FamilyGroup[];
  targetWorkflow?: string;
  onSelect: (key: string) => void;
  /** Whether there are any incompatible items (to show the toggle) */
  hasIncompatibleItems?: boolean;
}

function BaseModelListContent({
  value,
  recentItems,
  groupedByFamily,
  targetWorkflow,
  onSelect,
  hasIncompatibleItems,
}: BaseModelListContentProps) {
  const [showAll, setShowAll] = useState(false);

  // Filter grouped items based on toggle state
  const filteredGroups = useMemo(() => {
    if (showAll) return groupedByFamily;

    return groupedByFamily
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => item.compatible),
      }))
      .filter((group) => group.items.length > 0);
  }, [groupedByFamily, showAll]);

  return (
    <Stack gap="md">
      {/* Header row: Recent label (if any) and toggle */}
      {(recentItems.length > 0 || hasIncompatibleItems) && (
        <Group justify="space-between">
          {recentItems.length > 0 && (
            <Text size="xs" c="dimmed" fw={500}>
              Recent
            </Text>
          )}
          {hasIncompatibleItems && (
            <Switch
              label="Show all"
              size="xs"
              checked={showAll}
              onChange={(e) => setShowAll(e.currentTarget.checked)}
              className={recentItems.length === 0 ? 'ml-auto' : ''}
            />
          )}
        </Group>
      )}

      {/* Recent selections as inline badges (always compatible) */}
      {recentItems.length > 0 && (
        <>
          <Group gap="xs">
            {recentItems.map((item) => (
              <Badge
                key={item.key}
                component="button"
                onClick={() => onSelect(item.key)}
                variant={value === item.key ? 'filled' : 'outline'}
                color={value === item.key ? 'blue' : 'gray'}
                size="sm"
                radius="sm"
                className="cursor-pointer"
              >
                {item.name}
              </Badge>
            ))}
          </Group>
          <Divider />
        </>
      )}

      {/* All models grouped by family */}
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
              if (!item.compatible && targetWorkflow) {
                return (
                  <Tooltip
                    key={item.key}
                    label={`Will switch to ${targetWorkflow}`}
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
  recentItems: EcosystemItem[];
  groupedByFamily: FamilyGroup[];
  targetWorkflow?: string;
  onSelect: (key: string) => void;
  hasIncompatibleItems?: boolean;
}

function BaseModelSelectModal({
  value,
  recentItems,
  groupedByFamily,
  targetWorkflow,
  onSelect,
  hasIncompatibleItems,
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
          targetWorkflow={targetWorkflow}
          onSelect={handleSelect}
          hasIncompatibleItems={hasIncompatibleItems}
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
  targetWorkflow,
  outputType,
}: BaseModelInputProps) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [popoverOpened, { close: closePopover, open: openPopover }] = useDisclosure(false);
  const [recentEcosystems, setRecentEcosystems] = useLocalStorage<string[]>({
    key: RECENT_ECOSYSTEMS_KEY,
    defaultValue: [],
  });

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

  // Build set of supported ecosystems from compatibleEcosystems prop
  // Used to prioritize compatible ecosystems in sorting
  const supportedEcosystems = useMemo(() => {
    if (compatibleEcosystems && compatibleEcosystems.length > 0) {
      return new Set(compatibleEcosystems);
    }
    return null; // No filtering
  }, [compatibleEcosystems]);

  // Get ecosystems valid for the current output type (image/video)
  const outputTypeEcosystems = useMemo(() => {
    if (!outputType) return null; // No filtering if no output type specified
    const keys = getGenerationEcosystemsForMediaType(outputType);
    return new Set(keys);
  }, [outputType]);

  // Get ecosystem items filtered by output type, with compatibility marking
  const items = useMemo(() => {
    return ecosystems
      .filter((eco) => {
        // Filter by output type if specified
        if (outputTypeEcosystems && !outputTypeEcosystems.has(eco.key)) return false;
        return true;
      })
      .sort((a, b) => {
        // Sort compatible items first, then by sortOrder
        const aCompatible = !supportedEcosystems || supportedEcosystems.has(a.key);
        const bCompatible = !supportedEcosystems || supportedEcosystems.has(b.key);
        if (aCompatible !== bCompatible) return aCompatible ? -1 : 1;
        return (a.sortOrder ?? 999) - (b.sortOrder ?? 999);
      })
      .map((eco) => {
        // Get description from ecosystem's family
        const family = eco.familyId ? ecosystemFamilyById.get(eco.familyId) : undefined;
        // Use isCompatible prop if provided, otherwise fall back to supportedEcosystems
        const compatible = isCompatible
          ? isCompatible(eco.key)
          : !supportedEcosystems || supportedEcosystems.has(eco.key);
        return {
          key: eco.key,
          name: eco.displayName,
          description: eco.description ?? family?.description,
          familyId: eco.familyId,
          compatible,
        };
      });
  }, [supportedEcosystems, isCompatible, outputTypeEcosystems]);

  // Check if there are any incompatible items (to show the toggle)
  const hasIncompatibleItems = useMemo(() => {
    return items.some((item) => !item.compatible);
  }, [items]);

  // Get readable name for current value
  const readableName = useMemo(() => {
    const eco = value ? ecosystemByKey.get(value) : undefined;
    return eco?.displayName ?? value ?? 'Select';
  }, [value]);

  // Group items by family
  const groupedByFamily = useMemo(() => {
    const familyMap = new Map<number | null, EcosystemItem[]>();

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
    onChange?.(key);
    trackRecentSelection(key);
    closePopover();
  };

  // Get recent items - filter for compatible ones first, then take up to MAX_RECENT_DISPLAY
  const recentItems = useMemo(() => {
    return recentEcosystems
      .map((eco) => items.find((item) => item.key === eco))
      .filter((item): item is EcosystemItem => item !== undefined && item.compatible)
      .slice(0, MAX_RECENT_DISPLAY);
  }, [recentEcosystems, items]);

  const openMobileModal = () => {
    dialogStore.trigger({
      id: 'basemodel-select',
      component: BaseModelSelectModal,
      props: {
        value,
        recentItems,
        groupedByFamily,
        targetWorkflow,
        hasIncompatibleItems,
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
          targetWorkflow={targetWorkflow}
          onSelect={handleSelect}
          hasIncompatibleItems={hasIncompatibleItems}
        />
      </Popover.Dropdown>
    </Popover>
  );
}
