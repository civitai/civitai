import { Badge, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import React from 'react';
import { FeedCard } from '~/components/Cards/FeedCard';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useRouter } from 'next/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { BountyGetAll } from '~/types/router';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import {
  IconBolt,
  IconClockHour4,
  IconHeart,
  IconMessage2,
  IconViewfinder,
} from '@tabler/icons-react';
import dayjs from 'dayjs';

const IMAGE_CARD_WIDTH = 332;

export function BountyCard({ data }: Props) {
  const { classes, cx, theme } = useCardStyles({ aspectRatio: 1 });
  const router = useRouter();
  const { id, name, images, user, type, expiresAt } = data;
  // TODO.bounty: applyUserPreferences on bounty image
  const cover = images?.[0];

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
                          <Text color="white" size="xs" transform="capitalize">
                            {getDisplayName(type)}
                          </Text>
                        </Badge>
                      )}
                      {Date.now() > expiresAt.valueOf() && (
                        <Badge className={classes.chip} color="red" variant="filled" radius="xl">
                          Expired
                        </Badge>
                      )}
                    </Group>
                    <IconBadge
                      radius="xl"
                      color="dark"
                      variant="filled"
                      px={8}
                      h={26}
                      icon={<IconClockHour4 size={14} color={theme.colors.success[5]} />}
                    >
                      <Text color="success.5" size="xs">
                        {dayjs(expiresAt).toNow(true)}
                      </Text>
                    </IconBadge>
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
            <Text size="xl" weight={700} lineClamp={2} lh={1.2}>
              {name}
            </Text>
          </Stack>
          <Group spacing={8} position="apart">
            {/* TODO.bounty: use correct field when metrics are in place */}
            <IconBadge
              className={classes.chip}
              icon={
                <IconBolt size={14} color={theme.colors.accent[5]} fill={theme.colors.accent[5]} />
              }
              radius="xl"
              px={8}
              sx={(theme) => ({ backgroundColor: theme.fn.rgba('#000', 0.31) })}
              variant="filled"
            >
              <Text size="xs" color="accent.5">
                0
              </Text>
            </IconBadge>

            <Badge
              className={classes.chip}
              sx={(theme) => ({ backgroundColor: theme.fn.rgba('#000', 0.31) })}
              radius="xl"
              px={8}
              variant="filled"
            >
              {/* TODO.bounty: use correct fields when metrics are in place */}
              <Group spacing="xs" noWrap>
                <IconBadge
                  icon={<IconViewfinder size={14} />}
                  color="dark"
                  p={0}
                  size="lg"
                  // @ts-ignore: transparent variant does work
                  variant="transparent"
                >
                  <Text size="xs">{abbreviateNumber(0)}</Text>
                </IconBadge>
                <IconBadge
                  icon={<IconHeart size={14} />}
                  color="dark"
                  p={0}
                  size="lg"
                  // @ts-ignore
                  variant="transparent"
                >
                  <Text size="xs">{abbreviateNumber(0)}</Text>
                </IconBadge>
                <IconBadge
                  icon={<IconMessage2 size={14} />}
                  color="dark"
                  p={0}
                  size="lg"
                  // @ts-ignore
                  variant="transparent"
                >
                  <Text size="xs">{abbreviateNumber(0)}</Text>
                </IconBadge>
              </Group>
            </Badge>
          </Group>
        </Stack>
      </div>
    </FeedCard>
  );
}

type Props = { data: BountyGetAll[number] };
