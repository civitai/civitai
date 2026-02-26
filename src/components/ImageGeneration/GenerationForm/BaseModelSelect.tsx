import { Button, Modal, Text, UnstyledButton } from '@mantine/core';
import { useMemo } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { GenerationConfigKey } from '~/server/common/constants';
import { generationConfig } from '~/server/common/constants';
import type { BaseModelFamily, BaseModelGroup } from '~/shared/constants/base-model.constants';
import {
  baseModelFamilyConfig,
  baseModelGroupConfig,
  getGenerationBaseModelConfigs,
} from '~/shared/constants/base-model.constants';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useIsMobile } from '~/hooks/useIsMobile';

export function BaseModelSelect({ value, type }: { value?: string; type: MediaType }) {
  const handleClick = () =>
    dialogStore.trigger({
      id: 'base-model-modal',
      component: BaseModelSelectModal,
      props: { type },
    });

  const configs = getGenerationBaseModelConfigs(type);
  const items = configs
    .filter((group) => !!generationConfig[group as GenerationConfigKey])
    .map((group) => ({ group, ...baseModelGroupConfig[group] }));
  const readableName = items.find((x) => x.group === value)?.name ?? value ?? 'BaseModel';

  return (
    <div className="flex items-center gap-1">
      <Text size="sm" c="dimmed" className="mt-1">
        Base Model:
      </Text>
      <UnstyledButton
        size="xs"
        onClick={handleClick}
        className="flex items-center gap-1 font-bold text-blue-5 underline decoration-blue-5 decoration-2"
      >
        {readableName}
      </UnstyledButton>
    </div>
  );
}

type GroupedItem = {
  group: BaseModelGroup;
  name: string;
  description: string;
  family?: BaseModelFamily;
  selector?: string;
};

type FamilyGroup = {
  family: BaseModelFamily | null;
  familyName: string | null;
  familyDescription: string | null;
  items: GroupedItem[];
};

function BaseModelSelectModal({ type }: { type: MediaType }) {
  const dialog = useDialogContext();

  const configs = getGenerationBaseModelConfigs(type);
  const items: GroupedItem[] = configs
    .filter((group) => !!generationConfig[group as GenerationConfigKey])
    .map((group) => ({ group, ...baseModelGroupConfig[group] }));

  // Group items by family
  const groupedByFamily = useMemo(() => {
    // Deduplicate by selector: items sharing a selector collapse into one entry
    const deduped = items.reduce<GroupedItem[]>((acc, item) => {
      if (item.selector) {
        if (acc.some((x) => x.selector === item.selector)) return acc;
        return [...acc, { ...item, name: item.selector }];
      }
      return [...acc, item];
    }, []);

    const familyMap = new Map<BaseModelFamily | null, GroupedItem[]>();

    for (const item of deduped) {
      const family = item.family ?? null;
      const existing = familyMap.get(family) ?? [];
      familyMap.set(family, [...existing, item]);
    }

    // Convert to array and sort: families first (alphabetically), then standalone items
    const result: FamilyGroup[] = [];

    // Add family groups first (excluding disabled families)
    const families = [...familyMap.entries()]
      .filter(([family]) => family !== null && !baseModelFamilyConfig[family!].disabled)
      .sort(([a], [b]) => {
        const nameA = baseModelFamilyConfig[a!].name;
        const nameB = baseModelFamilyConfig[b!].name;
        return nameA.localeCompare(nameB);
      });

    for (const [family, familyItems] of families) {
      result.push({
        family,
        familyName: baseModelFamilyConfig[family!].name,
        familyDescription: baseModelFamilyConfig[family!].description,
        items: familyItems,
      });
    }

    // Items from disabled families go to standalone
    const disabledFamilyItems = [...familyMap.entries()]
      .filter(([family]) => family !== null && baseModelFamilyConfig[family!].disabled)
      .flatMap(([, items]) => items);

    // Add standalone items (no family + items from disabled families) at the end
    const standalone = [...(familyMap.get(null) ?? []), ...disabledFamilyItems];
    if (standalone.length) {
      result.push({
        family: null,
        familyName: null,
        familyDescription: null,
        items: standalone,
      });
    }

    return result;
  }, [items]);

  const handleSelect = (group: BaseModelGroup) => {
    const resource = generationConfig[group as GenerationConfigKey].checkpoint;
    generationGraphPanel.open({ type: 'modelVersion', id: resource.id });
    dialog.onClose();
  };

  const isMobile = useIsMobile();

  return (
    <Modal {...dialog} fullScreen={isMobile} title="Select Base Model">
      <div className="flex flex-col gap-4">
        {groupedByFamily.map((familyGroup) => (
          <div key={familyGroup.family ?? 'standalone'}>
            {familyGroup.familyName && (
              <Text className="mb-1 font-bold">{familyGroup.familyName}</Text>
            )}
            {!familyGroup.familyName && familyGroup.items.length > 0 && (
              <Text className="mb-1 font-bold">Other Models</Text>
            )}
            {familyGroup.familyDescription && (
              <Text size="xs" c="dimmed" className="mb-2">
                {familyGroup.familyDescription}
              </Text>
            )}
            <div className="flex flex-wrap gap-2">
              {familyGroup.items.map((item) => (
                <Button
                  key={item.group}
                  size="xs"
                  variant="outline"
                  onClick={() => handleSelect(item.group)}
                >
                  {item.name}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
