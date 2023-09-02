import { Badge, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import React from 'react';
import { FeedCard } from '~/components/Cards/FeedCard';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useRouter } from 'next/router';
import { IconBookmark, IconEye, IconMessageCircle2 } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { formatDate } from '~/utils/date-helpers';
import { ArticleGetAll, BountyGetAll } from '~/types/router';
import { ArticleContextMenu } from '~/components/Article/ArticleContextMenu';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';

const IMAGE_CARD_WIDTH = 332;

export function BountyCard({ data }: Props) {
  const { classes, cx } = useCardStyles({ aspectRatio: 1 });
  const router = useRouter();
  const { id, name, images, user, type, createdAt, expiresAt } = data;
  // TODO.bounty: applyUserPreferences on bounty image
  const cover = images[0];

  return (
    <FeedCard href={`/bounties/${id}/${slugit(name)}`} aspectRatio="square">
      <div className={classes.root}>
        <ImageGuard
          images={cover ? [cover] : []}
          connect={{ entityId: data.id, entityType: 'bounty' }}
          render={(image) => (
            <ImageGuard.Content>
              {({ safe }) => (
                <>
                  <Group
                    spacing={4}
                    position="apart"
                    className={cx(classes.contentOverlay, classes.top)}
                    noWrap
                  >
                    <Group spacing={4}>
                      <ImageGuard.ToggleConnect position="static" />
                      {type && (
                        <Badge
                          className={cx(classes.infoChip, classes.chip)}
                          variant="light"
                          radius="xl"
                        >
                          {getDisplayName(type)}
                        </Badge>
                      )}
                      {Date.now() > expiresAt.valueOf() && (
                        <Badge className={classes.chip} color="red" variant="filled" radius="xl">
                          Expired
                        </Badge>
                      )}
                    </Group>
                    {/* <ArticleContextMenu article={data} ml="auto" /> */}
                  </Group>
                  {image ? (
                    safe ? (
                      <EdgeMedia
                        src={image.url}
                        name={image.name ?? image.id.toString()}
                        alt={image.name ?? undefined}
                        type={image.type}
                        width={IMAGE_CARD_WIDTH}
                        className={classes.image}
                      />
                    ) : (
                      <MediaHash {...cover} />
                    )
                  ) : (
                    <Text color="dimmed">This bounty has no image</Text>
                  )}
                </>
              )}
            </ImageGuard.Content>
          )}
        />
        <Stack
          className={cx(classes.contentOverlay, classes.bottom, classes.fullOverlay)}
          spacing="sm"
        >
          {user ? (
            user?.id !== -1 && (
              <UnstyledButton
                sx={{ color: 'white' }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  router.push(`/user/${user.username}`);
                }}
              >
                <UserAvatar user={user} avatarProps={{ radius: 'md', size: 32 }} withUsername />
              </UnstyledButton>
            )
          ) : (
            <UserAvatar user={user} />
          )}
          <Stack spacing={0}>
            <Text size="xs" weight={500} color="white" inline>
              {formatDate(createdAt)}
            </Text>
            <Text size="xl" weight={700} lineClamp={2} lh={1.2}>
              {name}
            </Text>
          </Stack>
          {/* <Group position="apart">
            <Group spacing={4}>
              <IconBadge icon={<IconBookmark size={14} />} color="dark">
                <Text size="xs">{abbreviateNumber(favoriteCount)}</Text>
              </IconBadge>
              <IconBadge icon={<IconMessageCircle2 size={14} />} color="dark">
                <Text size="xs">{abbreviateNumber(commentCount)}</Text>
              </IconBadge>
            </Group>
            <IconBadge icon={<IconEye size={14} />} color="dark">
              <Text size="xs">{abbreviateNumber(viewCount)}</Text>
            </IconBadge>
          </Group> */}
        </Stack>
      </div>
    </FeedCard>
  );
}

type Props = { data: BountyGetAll[number] };
