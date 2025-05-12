import { Badge, Group, HoverCard, Stack, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import React from 'react';
import { FeedCard } from '~/components/Cards/FeedCard';
import cardClasses from '~/components/Cards/Cards.module.scss';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useRouter } from 'next/router';
import { ClubGetAll } from '~/types/router';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { IconAlertCircle, IconArticle, IconFiles, IconUsers } from '@tabler/icons-react';
import { abbreviateNumber } from '../../utils/number-helpers';
import { IconBadge } from '../IconBadge/IconBadge';
import { truncate } from 'lodash-es';
import { constants } from '~/server/common/constants';

const IMAGE_CARD_WIDTH = 450;

export function ClubCard({ data }: Props) {
  const router = useRouter();
  const { id, name, coverImage, user, stats } = data;

  return (
    <FeedCard href={`/clubs/${id}`} aspectRatio="square">
      <div className={cardClasses.root}>
        {/* <ImageGuard
          images={coverImage ? [coverImage] : []}
          connect={{ entityId: id, entityType: 'club' }}
          render={(image) => (
            <ImageGuard.Content>
              {({ safe }) => (
                <>
                  <Group
                    gap={4}
                    justify="space-between"
                    className={cx(cardClasses.contentOverlay, cardClasses.top)}
                    wrap="nowrap"
                  >
                    <Group gap={4}>
                      <ImageGuard.ToggleConnect position="static" />
                    </Group>
                    {data.nsfw && (
                      <Badge color="red" variant="filled" radius="xl">
                        NSFW
                      </Badge>
                    )}
                  </Group>
                  {image ? (
                    safe ? (
                      <EdgeMedia
                        src={image.url}
                        name={image.name ?? image.id.toString()}
                        alt={
                          image.meta
                            ? truncate(image.meta.prompt, { length: constants.altTruncateLength })
                            : image.name ?? undefined
                        }
                        type={image.type}
                        width={IMAGE_CARD_WIDTH}
                        className={cardClasses.image}
                      />
                    ) : (
                      <MediaHash {...coverImage} />
                    )
                  ) : (
                    <Text color="dimmed">This club has no cover image</Text>
                  )}
                </>
              )}
            </ImageGuard.Content>
          )}
        /> */}
        <Stack
          className={cx(cardClasses.contentOverlay, cardClasses.bottom, cardClasses.fullOverlay)}
          gap="sm"
        >
          {user ? (
            user?.id !== -1 && (
              <UnstyledButton
                sx={{ color: 'white', alignSelf: 'flex-start' }}
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

          <Group justify="space-between" align="start" gap={8}>
            <Text size="xl" weight={700} lineClamp={2} lh={1.2}>
              {name}
            </Text>

            {coverImage && !coverImage?.scannedAt && (
              <HoverCard width={300} position="top-end" withinPortal withArrow>
                <HoverCard.Target>
                  <ThemeIcon radius="xl" size="md" color="yellow">
                    <IconAlertCircle size={16} />
                  </ThemeIcon>
                </HoverCard.Target>
                <HoverCard.Dropdown>
                  <Stack gap={0}>
                    <Text color="yellow" weight={590}>
                      Pending scan
                    </Text>
                    <Text size="sm">
                      This club won&apos;t be visible publicly until it has completed the image scan
                      process
                    </Text>
                  </Stack>
                </HoverCard.Dropdown>
              </HoverCard>
            )}
          </Group>
          <Group gap={8} justify="space-between">
            <Badge
              className={cardClasses.chip}
              style={{
                backgroundColor: 'rgba(0, 0, 0, 0.31)',
              }}
              radius="xl"
              px={8}
              variant="filled"
            >
              <Group gap="xs" wrap="nowrap">
                <IconBadge
                  icon={<IconUsers size={14} />}
                  color={theme.colorScheme === 'dark' ? 'dark' : 'gray.0'}
                  p={0}
                  size="lg"
                  // @ts-ignore
                  variant="transparent"
                >
                  <Text size="xs">{abbreviateNumber(stats?.memberCount ?? 0)}</Text>
                </IconBadge>
                <IconBadge
                  icon={<IconArticle size={14} />}
                  color={theme.colorScheme === 'dark' ? 'dark' : 'gray.0'}
                  p={0}
                  size="lg"
                  // @ts-ignore
                  variant="transparent"
                >
                  <Text size="xs">{abbreviateNumber(stats?.clubPostCount ?? 0)}</Text>
                </IconBadge>
                <IconBadge
                  icon={<IconFiles size={14} />}
                  color={theme.colorScheme === 'dark' ? 'dark' : 'gray.0'}
                  p={0}
                  size="lg"
                  // @ts-ignore
                  variant="transparent"
                >
                  <Text size="xs">{abbreviateNumber(stats?.resourceCount ?? 0)}</Text>
                </IconBadge>
              </Group>
            </Badge>
          </Group>
        </Stack>
      </div>
    </FeedCard>
  );
}

type Props = { data: ClubGetAll[number] };
