import {
  ActionIcon,
  Alert,
  Badge,
  Card,
  CopyButton,
  Divider,
  Group,
  Skeleton,
  Stack,
  Text,
  useMantineTheme,
} from '@mantine/core';
import { useSessionStorage } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { IconDownload, IconMessageCircle2, IconX } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { cloneElement, useMemo, useState } from 'react';

import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import classes from './ImageResources.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

const LIMIT = 3;
export function ImageResources({ imageId }: { imageId: number }) {
  const currentUser = useCurrentUser();
  const theme = useMantineTheme();
  const queryUtils = trpc.useUtils();

  const [selectedResource, setSelectedResource] = useState<number | null>(null);
  const [showAll, setShowAll] = useSessionStorage<boolean>({
    key: 'showAllImageResources',
    defaultValue: false,
  });

  const { data, isLoading } = trpc.image.getResources.useQuery(
    { id: imageId },
    { trpc: { context: { skipBatch: true } } }
  );

  const { data: { Recommended: reviewedModels = [] } = { Recommended: [] } } =
    trpc.user.getEngagedModels.useQuery(undefined, {
      enabled: !!currentUser,
      cacheTime: Infinity,
      staleTime: Infinity,
    });

  const resources = useMemo(() => {
    return (
      data
        // remove duplicates items from data based on modelVersionId
        ?.filter(
          (resource, index, items) =>
            !!resource.modelVersionId &&
            items.findIndex((t) => t.modelVersionId === resource.modelVersionId) === index
        )
        .map((resource, index) => {
          const hasReview = resource.modelId ? reviewedModels.includes(resource.modelId) : false;
          const isAvailable = resource.modelVersionId !== null;
          return {
            ...resource,
            key: resource.modelVersionId ?? resource.modelName ?? index,
            hasReview,
            isAvailable,
          };
        })
        .sort((a, b) => {
          if (a.isAvailable && !b.isAvailable) return -1;
          if (!a.isAvailable && b.isAvailable) return 1;
          if (a.hasReview && !b.hasReview) return -1;
          if (!a.hasReview && b.hasReview) return 1;
          return 0;
        }) ?? []
    );
  }, [data, reviewedModels]);

  const { mutate, isLoading: removingResource } = trpc.image.removeResource.useMutation();
  const handleRemoveResource = (modelVersionId: number) => {
    setSelectedResource(modelVersionId);
    openConfirmModal({
      centered: true,
      title: 'Remove Resource',
      children:
        'Are you sure you want to remove this resource from this image? This action is destructive and cannot be reverted.',
      labels: { confirm: 'Yes, remove it', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        mutate(
          { imageId, modelVersionId },
          {
            async onSuccess() {
              showSuccessNotification({
                title: 'Successfully removed resource',
                message: 'The resource was removed from the image',
              });
              await queryUtils.image.getResources.setData({ id: imageId }, (old = []) => {
                return old.filter((x) => x.modelVersionId !== modelVersionId);
              });
            },
            onError(error) {
              showErrorNotification({
                title: 'Unable to remove resource',
                error: new Error(error.message),
              });
            },
            onSettled() {
              setSelectedResource(null);
            },
          }
        ),
    });
  };

  return (
    <Stack gap={4}>
      {isLoading ? (
        <Stack gap="xs">
          <Skeleton height={16} radius="md" />
          <Skeleton height={16} radius="md" />
        </Stack>
      ) : !resources.length ? (
        <Alert>There are no resources associated with this image</Alert>
      ) : (
        (showAll ? resources : resources.slice(0, LIMIT)).map(
          ({ key, hasReview, isAvailable, ...resource }) => {
            const removing = selectedResource === resource.modelVersionId && removingResource;

            return (
              <Wrapper resource={resource} key={key}>
                <Card
                  p={8}
                  style={{
                    backgroundColor: theme.colors.dark[7],
                    opacity: removing ? 0.3 : isAvailable ? 1 : 0.3,
                  }}
                  withBorder
                >
                  <Stack gap="xs">
                    <Group gap={4} justify="space-between" wrap="nowrap">
                      <Text size="sm" fw={500} lineClamp={1}>
                        {resource.modelName ?? resource.name}
                      </Text>
                      {!isAvailable && (
                        <Badge radius="sm" size="sm" color="yellow">
                          Unavailable
                        </Badge>
                      )}
                      <Group gap={4} wrap="nowrap">
                        {resource.modelType && (
                          <Badge radius="sm" size="sm">
                            {getDisplayName(resource.modelType)}
                          </Badge>
                        )}
                        {/* {!isAvailable && resource.hash && (
                          <CopyButton value={resource.hash}>
                            {({ copy, copied }) => (
                              <Badge
                                onClick={copy}
                                radius="sm"
                                size="sm"
                                style={{ cursor: 'pointer' }}
                              >
                                {copied ? 'Copied...' : resource.hash}
                              </Badge>
                            )}
                          </CopyButton>
                        )} */}
                        {currentUser?.isModerator && (
                          <LegacyActionIcon
                            size="xs"
                            color="red"
                            onClick={(e: React.MouseEvent) => {
                              e.stopPropagation();
                              e.preventDefault();
                              e.nativeEvent.stopImmediatePropagation();

                              handleRemoveResource(resource.modelVersionId);
                            }}
                            disabled={removing}
                          >
                            <IconX size={14} stroke={1.5} />
                          </LegacyActionIcon>
                        )}
                      </Group>
                    </Group>
                    {isAvailable && (
                      <Group gap={8} justify="space-between" wrap="nowrap">
                        {resource.modelVersionName && (
                          <Text c="dimmed" size="sm" lineClamp={1}>
                            {resource.modelVersionName}
                          </Text>
                        )}
                        <Group gap={4} ml="auto" wrap="nowrap">
                          <IconBadge
                            className={classes.statBadge}
                            icon={
                              <Text c={hasReview ? 'success.5' : undefined} inline>
                                <ThumbsUpIcon size={14} filled={!!hasReview} />
                              </Text>
                            }
                            color={hasReview ? 'success.5' : 'gray'}
                          >
                            <Text size="xs">
                              {abbreviateNumber(resource.modelThumbsUpCount ?? 0)}
                            </Text>
                          </IconBadge>
                          <IconBadge
                            className={classes.statBadge}
                            icon={<IconMessageCircle2 size={14} />}
                          >
                            <Text size="xs">
                              {abbreviateNumber(resource.modelCommentCount ?? 0)}
                            </Text>
                          </IconBadge>
                          <IconBadge
                            className={classes.statBadge}
                            icon={<IconDownload size={14} />}
                          >
                            <Text fz={12}>
                              {abbreviateNumber(resource.modelDownloadCount ?? 0)}
                            </Text>
                          </IconBadge>
                        </Group>
                      </Group>
                    )}
                  </Stack>
                </Card>
              </Wrapper>
            );
          }
        )
      )}
      {resources.length > LIMIT && (
        <Divider
          label={
            <Group gap="xs" align="center">
              <Text
                variant="link"
                style={{ cursor: 'pointer' }}
                onClick={() => setShowAll((x) => !x)}
              >
                {!showAll ? 'Show more' : 'Show less'}
              </Text>
            </Group>
          }
          labelPosition="center"
          variant="dashed"
        />
      )}
    </Stack>
  );
}

const Wrapper = ({
  resource,
  children,
}: {
  resource: { modelId: number | null; modelName: string | null; modelVersionId: number | null };
  children: React.ReactElement;
}) => {
  if (!resource.modelId) return children;
  return (
    <Link
      href={`/models/${resource.modelId}/${slugit(resource.modelName ?? '')}?modelVersionId=${
        resource.modelVersionId
      }`}
    >
      {cloneElement(children, { component: 'a' })}
    </Link>
  );
};
