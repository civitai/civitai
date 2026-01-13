/**
 * BaseModelInput
 *
 * A form input component for selecting the base model group for generation.
 * When the base model changes, it notifies the ResourceDataProvider to
 * re-evaluate resource compatibility.
 */

import { Badge, Divider, Group, Modal, Stack, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure, useLocalStorage, useMediaQuery } from '@mantine/hooks';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useMemo } from 'react';
import {
  ecosystems,
  ecosystemByKey,
  ecosystemFamilies,
  ecosystemFamilyById,
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
}

type EcosystemItem = {
  key: string;
  name: string;
  description?: string;
  familyId?: number;
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
  const supportedEcosystems = useMemo(() => {
    if (compatibleEcosystems && compatibleEcosystems.length > 0) {
      return new Set(compatibleEcosystems);
    }
    return null; // No filtering
  }, [compatibleEcosystems]);

  // Get filtered ecosystem items
  const items = useMemo(() => {
    return ecosystems
      .filter((eco) => !supportedEcosystems || supportedEcosystems.has(eco.key))
      .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999))
      .map((eco) => {
        // Get description from ecosystem's family
        const family = eco.familyId ? ecosystemFamilyById.get(eco.familyId) : undefined;
        return {
          key: eco.key,
          name: eco.displayName,
          description: eco.description ?? family?.description,
          familyId: eco.familyId,
        };
      });
  }, [supportedEcosystems]);

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
        <UnstyledButton
          onClick={openModal}
          disabled={disabled}
          className="group flex items-center gap-0.5"
        >
          <Text
            size="sm"
            fw={500}
            className="underline decoration-dotted underline-offset-2 group-hover:decoration-solid"
          >
            {readableName}
          </Text>
          <IconChevronDown size={14} className="text-gray-500" />
        </UnstyledButton>
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
                {recentItems.map((item) => (
                  <Badge
                    key={item.key}
                    component="button"
                    onClick={() => handleSelect(item.key)}
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
          {groupedByFamily.map((familyGroup) => (
            <div key={familyGroup.familyId ?? 'standalone'}>
              {/* Family header */}
              <Text size="xs" c="dimmed" fw={600} tt="uppercase" className="mb-2">
                {familyGroup.familyName ?? 'Other'}
              </Text>

              {/* List of ecosystems */}
              <Stack gap={0}>
                {familyGroup.items.map((item) => (
                  <UnstyledButton
                    key={item.key}
                    onClick={() => handleSelect(item.key)}
                    className={clsx(
                      'flex w-full items-center justify-between rounded px-3 py-2 transition-colors',
                      value === item.key
                        ? 'bg-blue-0 dark:bg-blue-9/20'
                        : 'hover:bg-gray-0 dark:hover:bg-dark-6'
                    )}
                  >
                    <div className="flex-1">
                      <Text size="sm" fw={value === item.key ? 600 : 400}>
                        {item.name}
                      </Text>
                      {item.description && (
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {item.description}
                        </Text>
                      )}
                    </div>
                    {value === item.key && <IconCheck size={16} className="text-blue-6" />}
                  </UnstyledButton>
                ))}
              </Stack>
            </div>
          ))}
        </Stack>
      </Modal>
    </>
  );
}
