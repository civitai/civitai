import { Button, Modal, UnstyledButton, Text } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { TwCard } from '~/components/TwCard/TwCard';
import type { GenerationConfigKey } from '~/server/common/constants';
import { generationConfig } from '~/server/common/constants';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import type { BaseModel, BaseModelGroup } from '~/shared/constants/base-model.constants';
import {
  baseModelGroupConfig,
  getBaseModelConfigsByMediaType,
  getBaseModelGroupsByMediaType,
  getGenerationBaseModelConfigs,
  getGenerationBaseModelsByMediaType,
} from '~/shared/constants/base-model.constants';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { generationPanel, generationStore } from '~/store/generation.store';

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
    <Button size="xs" className="h-6" onClick={handleClick}>
      {readableName}
    </Button>
  );
}

function BaseModelSelectModal({ type }: { type: MediaType }) {
  const dialog = useDialogContext();

  // const groups = getBaseModelGroupsByMediaType(type);
  const configs = getGenerationBaseModelConfigs(type);
  const items = configs
    .filter((group) => !!generationConfig[group as GenerationConfigKey])
    .map((group) => ({ group, ...baseModelGroupConfig[group] }));

  return (
    <Modal {...dialog}>
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <UnstyledButton
            key={item.group}
            onClick={() => {
              const resource = generationConfig[item.group as GenerationConfigKey].checkpoint;
              generationPanel.open({ type: 'modelVersion', id: resource.id });
              dialog.onClose();
            }}
          >
            <TwCard className="border px-3 py-2">
              <Text className="font-bold">{item.name}</Text>
              <Text size="xs">{item.description}</Text>
            </TwCard>
          </UnstyledButton>
        ))}
      </div>
    </Modal>
  );
}
