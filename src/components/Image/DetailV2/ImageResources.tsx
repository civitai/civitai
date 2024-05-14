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
  createStyles,
} from '@mantine/core';
import { useSessionStorage } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { IconDownload, IconMessageCircle2, IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { cloneElement, useMemo, useState } from 'react';

import { IconBadge } from '~/components/IconBadge/IconBadge';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
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
      data?.resources
        // remove duplicates items from data based on modelVersionId
        ?.filter(
          (resource, index, items) =>
            !!resource.modelVersionId &&
            items.findIndex((t) => t.modelVersionId === resource.modelVersionId) === index
        )
        .map((resource, index) => {
          const isAvailable = resource.modelVersionId !== null;
          return {
            ...resource,
            key: resource.modelVersionId ?? resource.modelName ?? index,
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

  // TODO - mod tooling?

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
        <ul className="list-none flex flex-col gap-0.5">
          {(showAll ? resources : resources.slice(0, LIMIT)).map((resource, i) => (
            <li
              key={resource.modelVersionId ?? i}
              className="flex justify-between items-center gap-3"
            >
              <Wrapper resource={resource}>
                <Text
                  lineClamp={1}
                  color="dimmed"
                  className={`${resource.modelId ? 'underline cursor-pointer' : ''}`}
                >
                  {resource.modelName ?? resource.name}
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
                </div>
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
            {!showAll ? 'Show more' : 'Show less'}
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
  resource: { modelId: number | null; modelName: string | null; modelVersionId: number | null };
  children: React.ReactElement;
}) => {
  if (!resource.modelId) return children;
  return (
    <Link
      href={`/models/${resource.modelId}/${slugit(resource.modelName ?? '')}?modelVersionId=${
        resource.modelVersionId
      }`}
      passHref
    >
      {cloneElement(children, { component: 'a' })}
    </Link>
  );
};
