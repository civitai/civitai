import { showNotification } from '@mantine/notifications';
import { ModelType } from '@prisma/client';
import { useState } from 'react';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { CommandResourcesAdd } from '~/components/CivitaiLink/shared-types';
import { ModelHashModel } from '~/server/selectors/modelHash.selector';
import { trpc } from '~/utils/trpc';

const supportedModelTypes: ModelType[] = ['Checkpoint', 'Hypernetwork', 'TextualInversion', 'LORA'];

export function CivitaiLinkResourceManager({
  modelId,
  modelName,
  modelType,
  modelVersionId,
  hashes,
  children,
}: {
  modelId: number;
  modelName: string;
  modelType: ModelType;
  modelVersionId?: number;
  hashes: string[];
  children: (props: CivitaiLinkResourceManagerChildrenFunction) => JSX.Element;
}) {
  const { connected, resources, runCommand } = useCivitaiLink();
  const resource = resources.find(({ hash }) => hashes.some((x) => x === hash));
  const [cancels, setCancels] = useState<Array<() => void>>([]);
  const { data, refetch, isFetched } = trpc.model.getDownloadCommand.useQuery(
    { modelId, modelVersionId },
    {
      enabled: false,
      onSuccess(data) {
        runAddCommands(data?.commands);
      },
    }
  );
  if (!connected || !supportedModelTypes.includes(modelType)) return null;
  const runAddCommands = async (commands: CommandResourcesAdd[] | undefined) => {
    if (!commands) return;
    const addCancels: typeof cancels = [];
    for (const command of commands) {
      const { cancel } = await runCommand(command);
      addCancels.push(cancel);
    }
    setCancels((x) => [...x, ...addCancels]);
  };

  const addResource = () => {
    if (resource) return;
    if (!isFetched) refetch();
    else if (data) runAddCommands(data.commands);
    else showNotification({ message: 'Could not get commands' });
  };

  const cancelDownload = () => {
    if (!resource) return;
    cancels.map((cancel) => cancel());
    setCancels([]);
  };

  const removeResource = async () => {
    if (!resource) return;
    await runCommand({
      type: 'resources:remove',
      resource: { ...resource, modelName },
    });
  };

  return children({
    addResource,
    removeResource,
    cancelDownload,
    resource,
    hasResource: !!resource,
    downloading: resource?.downloading ?? false,
  });
}

export type CivitaiLinkResourceManagerProps = {
  modelId: number;
  modelName: string;
  modelType: ModelType;
  modelVersionId?: number;
  hashes: string[];
};

type CivitaiLinkResourceManagerChildrenFunction = {
  addResource: () => void;
  removeResource: () => void;
  cancelDownload: () => void;
  resource: ModelHashModel | undefined;
  downloading: boolean;
  hasResource: boolean;
};
