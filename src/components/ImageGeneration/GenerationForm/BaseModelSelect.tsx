import { Button, Modal, Text, UnstyledButton } from '@mantine/core';
import { useMemo } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { GenerationConfigKey } from '~/server/common/constants';
import { generationConfig } from '~/server/common/constants';
import type { BaseModelFamilyRecord, BaseModelGroup } from '~/shared/constants/basemodel.constants';
import {
  baseModelGroupConfig,
  ecosystemByKey,
  ecosystemFamilies,
  getGenerationBaseModelConfigs,
} from '~/shared/constants/basemodel.constants';
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
    .map((group) => ({
      group,
      ...baseModelGroupConfig[group],
      familyId: ecosystemByKey.get(group)?.familyId,
    }));
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
  description?: string;
  familyId?: number;
};

type FamilyGroup = {
  family: BaseModelFamilyRecord | null;
  items: GroupedItem[];
};

function BaseModelSelectModal({ type }: { type: MediaType }) {
  const dialog = useDialogContext();

  const configs = getGenerationBaseModelConfigs(type);
  const items: GroupedItem[] = configs
    .filter((group) => !!generationConfig[group as GenerationConfigKey])
    .map((group) => ({
      group,
      ...baseModelGroupConfig[group],
      familyId: ecosystemByKey.get(group)?.familyId,
    }));

  // Group items by family
  const groupedByFamily = useMemo(() => {
    const familyMap = new Map<number | null, GroupedItem[]>();

    for (const item of items) {
      const key = item.familyId ?? null;
      const existing = familyMap.get(key) ?? [];
      familyMap.set(key, [...existing, item]);
    }

    // Convert to array and sort: families first (alphabetically), then standalone items
    const result: FamilyGroup[] = [];

    const families = [...familyMap.entries()]
      .filter(([id]) => id !== null)
      .sort(([a], [b]) => {
        const famA = ecosystemFamilies.find((f) => f.id === a);
        const famB = ecosystemFamilies.find((f) => f.id === b);
        return (famA?.name ?? '').localeCompare(famB?.name ?? '');
      });

    for (const [familyId, familyItems] of families) {
      const family = ecosystemFamilies.find((f) => f.id === familyId) ?? null;
      result.push({ family, items: familyItems });
    }

    // Add standalone items (no family) at the end
    const standalone = familyMap.get(null) ?? [];
    if (standalone.length) {
      result.push({ family: null, items: standalone });
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
          <div key={familyGroup.family?.id ?? 'standalone'}>
            {familyGroup.family ? (
              <Text className="mb-1 font-bold">{familyGroup.family.name}</Text>
            ) : (
              familyGroup.items.length > 0 && <Text className="mb-1 font-bold">Other Models</Text>
            )}
            {familyGroup.family?.description && (
              <Text size="xs" c="dimmed" className="mb-2">
                {familyGroup.family.description}
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
