import { showNotification } from '@mantine/notifications';
import { ModelType } from '@prisma/client';
import { useCallback } from 'react';
import { useCivitaiLink, useCivitaiLinkStore } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { CommandResourcesAdd } from '~/components/CivitaiLink/shared-types';
import { ModelHashModel } from '~/server/selectors/modelHash.selector';
import { trpc } from '~/utils/trpc';

const supportedModelTypes: ModelType[] = [
  'Checkpoint',
  'Hypernetwork',
  'TextualInversion',
  'LORA',
  'LoCon',
  'Controlnet',
];

export function CivitaiLinkResourceManager({
  modelId,
  modelName,
  modelType,
  modelVersionId,
  hashes,
  children,
  fallback,
}: {
  modelId: number;
  modelName: string;
  modelType: ModelType;
  modelVersionId?: number;
  hashes: string[];
  children: (props: CivitaiLinkResourceManagerChildrenFunction) => JSX.Element;
  fallback?: JSX.Element;
}) {
  const { connected, resources, runCommand } = useCivitaiLink();
  const resource = resources.find(({ hash }) => hashes.some((x) => x === hash));
  const activities = useCivitaiLinkStore(
    useCallback(
      (state) =>
        Object.values(state.activities).filter(
          (x) =>
            x.status == 'processing' &&
            x.type == 'resources:add' &&
            hashes.includes(x.resource.hash)
        ),
      [hashes]
    )
  );
  // const activities: Response[] = [];
  const { data, refetch, isFetched, isFetching } = trpc.model.getDownloadCommand.useQuery(
    { modelId, modelVersionId },
    {
      enabled: false,
      onSuccess(data) {
        runAddCommands(data?.commands);
      },
    }
  );

  if (!connected || !supportedModelTypes.includes(modelType) || !hashes || !hashes.length)
    return fallback ?? null;

  const runAddCommands = async (commands: CommandResourcesAdd[] | undefined) => {
    if (!commands) return;
    for (const command of commands) await runCommand(command);
  };

  const addResource = () => {
    if (resource) return;
    if (!isFetched) refetch();
    else if (data) runAddCommands(data.commands);
    else showNotification({ message: 'Could not get commands' });
  };

  const cancelDownload = () => {
    if (!resource || !activities.length) return;
    for (const { id } of activities) runCommand({ type: 'activities:cancel', activityId: id });
  };

  const removeResource = async () => {
    if (!resource) return;
    await runCommand({
      type: 'resources:remove',
      resource: { ...resource, modelName },
    });
  };

  const downloading = (isFetching || resource?.downloading) ?? false;
  const progress =
    downloading && activities.length ? Math.min(...activities.map((x) => x.progress ?? 0)) : 0;
  return children({
    addResource,
    removeResource,
    cancelDownload,
    resource,
    hasResource: !!resource,
    downloading,
    progress,
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
  progress: number;
  downloading: boolean;
  hasResource: boolean;
};
