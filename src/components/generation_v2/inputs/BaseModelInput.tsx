/**
 * BaseModelInput
 *
 * A form input component for selecting the base model group for generation.
 * When the base model changes, it notifies the ResourceDataProvider to
 * re-evaluate resource compatibility.
 */

import { Badge, Divider, Group, Modal, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure, useLocalStorage, useMediaQuery } from '@mantine/hooks';
import { IconCheck, IconChevronDown, IconArrowRight } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useMemo } from 'react';
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
const MAX_RECENT_ECOSYSTEMS = 3;

// =============================================================================
// Component
// =============================================================================

export function BaseModelInput({
  value,
  onChange,
  label = 'Base Model',
  compatibleEcosystems,
  disabled,
  isCompatible,
  targetWorkflow,
  outputType,
}: BaseModelInputProps) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [modalOpened, { open: openModal, close: closeModal }] = useDisclosure(false);
  const [recentEcosystems, setRecentEcosystems] = useLocalStorage<string[]>({
    key: RECENT_ECOSYSTEMS_KEY,
    defaultValue: [],
  });

  // Track selection in recent ecosystems
  const trackRecentSelection = useCallback(
    (ecosystem: string) => {
      setRecentEcosystems((prev) => {
        const filtered = prev.filter((e) => e !== ecosystem);
        return [ecosystem, ...filtered].slice(0, MAX_RECENT_ECOSYSTEMS);
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
    closeModal();
  };

  // Get recent items that are in the current supported ecosystems
  const recentItems = useMemo(() => {
    return recentEcosystems
      .filter((eco) => items.some((item) => item.key === eco))
      .map((eco) => items.find((item) => item.key === eco)!)
      .filter(Boolean);
  }, [recentEcosystems, items]);

  return (
    <>
      <div className="flex items-center gap-1">
        <Text size="sm" c="dimmed">
          {label}:
        </Text>
        {disabled ? (
          <Text size="sm" fw={500}>
            {readableName}
          </Text>
        ) : (
          <UnstyledButton onClick={openModal} className="group flex items-center gap-0.5">
            <Text
              size="sm"
              fw={500}
              className="underline decoration-dotted underline-offset-2 group-hover:decoration-solid"
            >
              {readableName}
            </Text>
            <IconChevronDown size={14} className="text-gray-500" />
          </UnstyledButton>
        )}
      </div>

      <Modal
        opened={modalOpened}
        onClose={closeModal}
        title="Select Base Model"
        size="md"
        fullScreen={isMobile}
      >
        <Stack gap="md">
          {/* Recent selections as inline badges */}
          {recentItems.length > 0 && (
            <>
              <Group gap="xs">
                <Text size="xs" c="dimmed" fw={500}>
                  Recent
                </Text>
                {recentItems.map((item) => {
                  const badge = (
                    <Badge
                      key={item.key}
                      component="button"
                      onClick={() => handleSelect(item.key)}
                      variant={value === item.key ? 'filled' : 'outline'}
                      color={value === item.key ? 'blue' : 'gray'}
                      size="sm"
                      radius="sm"
                      className={clsx('cursor-pointer', !item.compatible && 'opacity-60')}
                    >
                      {item.name}
                    </Badge>
                  );

                  if (!item.compatible && targetWorkflow) {
                    return (
                      <Tooltip
                        key={item.key}
                        label={`Will switch to ${targetWorkflow}`}
                        withArrow
                        openDelay={300}
                      >
                        {badge}
                      </Tooltip>
                    );
                  }

                  return badge;
                })}
              </Group>
              <Divider />
            </>
          )}

          {/* All models grouped by family */}
          {groupedByFamily.map((familyGroup) => (
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
                      onClick={() => handleSelect(item.key)}
                      className={clsx(
                        'flex w-full items-center justify-between rounded px-3 py-2 transition-colors',
                        isSelected
                          ? 'bg-blue-0 dark:bg-blue-9/20'
                          : 'hover:bg-gray-0 dark:hover:bg-dark-6',
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
      </Modal>
    </>
  );
}
