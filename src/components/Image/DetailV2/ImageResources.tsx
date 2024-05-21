import { ActionIcon, Alert, Badge, Skeleton, Stack, Text } from '@mantine/core';
import { useSessionStorage } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { IconX } from '@tabler/icons-react';
import { uniqBy } from 'lodash';
import Link from 'next/link';
import { cloneElement, useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const LIMIT = 3;

export function ImageResources({ imageId }: { imageId: number }) {
  const currentUser = useCurrentUser();
  const [showAll, setShowAll] = useSessionStorage<boolean>({
    key: 'showAllImageResources',
    defaultValue: false,
  });

  const { data, isLoading } = trpc.image.getGenerationData.useQuery({ id: imageId });

  const resources = useMemo(() => {
    return (
      uniqBy(data?.resources ?? [], 'versionId')
        .map((resource) => {
          const isAvailable = resource.versionId !== null;
          return {
            ...resource,
            isAvailable,
          };
        })
        .sort((a, b) => {
          if (a.isAvailable && !b.isAvailable) return -1;
          if (!a.isAvailable && b.isAvailable) return 1;
          return 0;
        }) ?? []
    );
  }, [data]);

  if (!resources.length) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <Text className="text-lg font-semibold">Resources used</Text>
      {isLoading ? (
        <Stack spacing="xs">
          <Skeleton height={16} radius="md" />
          <Skeleton height={16} radius="md" />
        </Stack>
      ) : !resources.length ? (
        <Alert>There are no resources associated with this image</Alert>
      ) : (
        <ul className="flex list-none flex-col gap-0.5">
          {(showAll ? resources : resources.slice(0, LIMIT)).map((resource) => (
            <li key={resource.id} className="flex flex-col">
              <div className="flex items-center justify-between gap-3">
                <Wrapper resource={resource}>
                  <Text
                    lineClamp={1}
                    className={`${resource.modelId ? 'cursor-pointer underline' : ''}`}
                  >
                    {resource.modelName}
                  </Text>
                </Wrapper>
                {resource.modelType && (
                  <div className="flex gap-1">
                    <Badge color="blue">{getDisplayName(resource.modelType)}</Badge>
                    {!!resource.strength && (
                      <Badge color="gray" variant="filled">
                        {resource.strength}
                      </Badge>
                    )}
                    {currentUser?.isModerator && (
                      <RemoveResource imageId={imageId} resourceId={resource.id} />
                    )}
                  </div>
                )}
              </div>
              {resource.versionName && (
                <Wrapper resource={resource}>
                  <Text
                    lineClamp={1}
                    color="dimmed"
                    className={`text-xs ${resource.modelId ? 'cursor-pointer' : ''}`}
                  >
                    {resource.versionName}
                  </Text>
                </Wrapper>
              )}
            </li>
          ))}
        </ul>
      )}
      {resources.length > LIMIT && (
        <div className="flex justify-start">
          <Text
            variant="link"
            className="cursor-pointer text-sm"
            onClick={() => setShowAll((x) => !x)}
          >
            {!showAll ? `Show ${resources.length - LIMIT} more` : 'Show less'}
          </Text>
        </div>
      )}
    </div>
  );
}

const Wrapper = ({
  resource,
  children,
}: {
  resource: { modelId: number | null; modelName: string | null; versionId: number | null };
  children: React.ReactElement;
}) => {
  if (!resource.modelId) return children;
  return (
    <Link
      href={`/models/${resource.modelId}/${slugit(resource.modelName ?? '')}?modelVersionId=${
        resource.versionId
      }`}
      passHref
    >
      {cloneElement(children, { component: 'a' })}
    </Link>
  );
};

function RemoveResource({ imageId, resourceId }: { imageId: number; resourceId: number }) {
  const queryUtils = trpc.useUtils();
  const { mutate, isLoading } = trpc.image.removeResource.useMutation();
  const handleRemoveResource = () => {
    openConfirmModal({
      centered: true,
      title: 'Remove Resource',
      children:
        'Are you sure you want to remove this resource from this image? This action is destructive and cannot be reverted.',
      labels: { confirm: 'Yes, remove it', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        mutate(
          { id: resourceId },
          {
            async onSuccess() {
              showSuccessNotification({
                title: 'Successfully removed resource',
                message: 'The resource was removed from the image',
              });
              await queryUtils.image.getResources.invalidate({ id: imageId });
            },
            onError(error) {
              showErrorNotification({
                title: 'Unable to remove resource',
                error: new Error(error.message),
              });
            },
          }
        ),
    });
  };

  return (
    <ActionIcon
      size="xs"
      color="red"
      variant="light"
      onClick={handleRemoveResource}
      disabled={isLoading}
      h={20}
      w={20}
    >
      <IconX size={14} stroke={1.5} />
    </ActionIcon>
  );
}
