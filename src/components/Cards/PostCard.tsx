import { Text } from '@mantine/core';
import React from 'react';
import cardClasses from '~/components/Cards/Cards.module.scss';
import { PostsInfiniteModel } from '~/server/services/post.service';
import { IconPhoto } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { AddArtFrameMenuItem } from '~/components/Decorations/AddArtFrameMenuItem';
import { CosmeticEntity } from '~/shared/utils/prisma/enums';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';

export function PostCard({ data }: Props) {
  const currentUser = useCurrentUser();

  const image = data.images[0];
  const isOwner = currentUser?.id === data.user.id;

  return (
    <AspectRatioImageCard
      href={`/posts/${data.id}`}
      aspectRatio="square"
      cosmetic={data.cosmetic?.data}
      image={image}
      contentType="post"
      contentId={data.id}
      header={
        <>
          <ImageContextMenu
            className="ml-auto"
            image={image}
            context="post"
            additionalMenuItems={
              isOwner ? (
                <AddArtFrameMenuItem
                  entityType={CosmeticEntity.Post}
                  entityId={data.id}
                  image={image}
                  currentCosmetic={data.cosmetic}
                />
              ) : null
            }
          />
        </>
      }
      footer={
        <div className="flex w-full flex-wrap items-end justify-between gap-1">
          <div className="flex flex-col gap-2">
            <UserAvatarSimple {...data.user} />
            {data.title && (
              <Text className={cardClasses.dropShadow} size="xl" fw={700} lineClamp={2} lh={1.2}>
                {data.title}
              </Text>
            )}
          </div>
          <IconBadge className={cardClasses.iconBadge} icon={<IconPhoto size={14} />}>
            <Text size="xs">{abbreviateNumber(data.imageCount)}</Text>
          </IconBadge>
        </div>
      }
    />
  );
}

type Props = { data: PostsInfiniteModel };
