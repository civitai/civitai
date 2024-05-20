import {
  Badge,
  BadgeProps,
  Group,
  HoverCard,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import {
  IconAlertCircle,
  IconClockHour4,
  IconHeart,
  IconMessageCircle2,
  IconSwords,
  IconViewfinder,
} from '@tabler/icons-react';
import { truncate } from 'lodash-es';
import { useRouter } from 'next/router';
import React from 'react';
import { useBountyEngagement } from '~/components/Bounty/bounty.utils';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { FeedCard } from '~/components/Cards/FeedCard';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { BountyGetAll } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { BountyContextMenu } from '../Bounty/BountyContextMenu';
import { DaysFromNow } from '../Dates/DaysFromNow';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { constants } from '~/server/common/constants';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';

const IMAGE_CARD_WIDTH = 450;

const sharedBadgeProps: Omit<BadgeProps, 'children'> = {
  radius: 'xl',
  variant: 'filled',
  px: 8,
  h: 26,
  tt: 'capitalize',
};

export function BountyCard({ data }: Props) {
  const { classes, cx, theme } = useCardStyles({ aspectRatio: 1 });
  const router = useRouter();
  const { id, name, images, user, type, expiresAt, stats, complete } = data;
  const image = images?.[0];
  const expired = expiresAt < new Date();

  const { engagements } = useBountyEngagement();

  const isFavorite = !!engagements?.Favorite?.find((value) => value === id);
  const isTracked = !!engagements?.Track?.find((value) => value === id);

  const countdownBadge = (
    <IconBadge
      {...sharedBadgeProps}
      color="dark"
      icon={<IconClockHour4 size={14} />}
      sx={(theme) => ({ backgroundColor: theme.fn.rgba('#000', 0.31) })}
    >
      <Text size="xs">
        <DaysFromNow date={expiresAt} withoutSuffix />
      </Text>
    </IconBadge>
  );

  const expiredBadge = (
    <Badge className={classes.chip} {...sharedBadgeProps} color="red" variant="filled" radius="xl">
      Expired
    </Badge>
  );

  const completeBadge = (
    <Badge
      className={classes.chip}
      {...sharedBadgeProps}
      color="yellow.7"
      variant="filled"
      radius="xl"
    >
      Awarded
    </Badge>
  );

  const deadlineBadge =
    complete && !!stats?.entryCountAllTime
      ? completeBadge
      : expired
      ? expiredBadge
      : countdownBadge;

  return (
    <FeedCard href={`/bounties/${id}/${slugit(name)}`} aspectRatio="square">
      <div className={classes.root}>
        {image && (
          <ImageGuard2 image={image} connectId={id} connectType="bounty">
            {(safe) => (
              <>
                <Group
                  spacing={4}
                  position="apart"
                  className={cx(classes.contentOverlay, classes.top)}
                  noWrap
                >
                  <Group spacing={4}>
                    <ImageGuard2.BlurToggle h={26} radius="xl" />
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
                  </Group>
                  {deadlineBadge}
                  <BountyContextMenu
                    bounty={data}
                    buttonProps={{ ml: 'auto', variant: 'transparent' }}
                    position="bottom-end"
                    withinPortal
                  />
                </Group>
                {safe ? (
                  <EdgeMedia
                    src={image.url}
                    name={image.name ?? image.id.toString()}
                    alt={
                      image.meta
                        ? truncate((image.meta as ImageMetaProps).prompt, {
                            length: constants.altTruncateLength,
                          })
                        : undefined
                    }
                    type={image.type}
                    width={IMAGE_CARD_WIDTH}
                    className={classes.image}
                  />
                ) : (
                  <MediaHash {...image} />
                )}
              </>
            )}
          </ImageGuard2>
        )}

        <Stack
          className={cx(classes.contentOverlay, classes.bottom, classes.fullOverlay)}
          spacing="sm"
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
                <UserAvatar user={user} avatarProps={{ radius: 'xl', size: 32 }} withUsername />
              </UnstyledButton>
            )
          ) : (
            <UserAvatar user={user} />
          )}
          <Group position="apart" align="start" spacing={8}>
            <Text size="xl" weight={700} lineClamp={2} lh={1.2}>
              {name}
            </Text>
            {!image.scannedAt && (
              <HoverCard width={300} position="top-end" withinPortal withArrow>
                <HoverCard.Target>
                  <ThemeIcon radius="xl" size="md" color="yellow">
                    <IconAlertCircle size={16} />
                  </ThemeIcon>
                </HoverCard.Target>
                <HoverCard.Dropdown>
                  <Stack spacing={0}>
                    <Text color="yellow" weight={590}>
                      Pending scan
                    </Text>
                    <Text size="sm">
                      This bounty won&apos;t be visible publicly until it has completed the image
                      scan process
                    </Text>
                  </Stack>
                </HoverCard.Dropdown>
              </HoverCard>
            )}
          </Group>
          <Group spacing={8} position="apart">
            <CurrencyBadge
              currency={Currency.BUZZ}
              unitAmount={stats?.unitAmountCountAllTime ?? 0}
              radius="xl"
              px={8}
              variant="filled"
              className={classes.chip}
              sx={(theme) => ({ backgroundColor: theme.fn.rgba('#000', 0.31) })}
            />
            <Badge
              className={classes.chip}
              sx={(theme) => ({ backgroundColor: theme.fn.rgba('#000', 0.31) })}
              radius="xl"
              px={8}
              variant="filled"
            >
              <Group spacing="xs" noWrap>
                <IconBadge
                  icon={
                    <IconViewfinder
                      size={14}
                      color={isTracked ? theme.colors.green[5] : 'currentColor'}
                    />
                  }
                  color={isTracked ? 'green' : theme.colorScheme === 'dark' ? 'dark' : 'gray.0'}
                  p={0}
                  size="lg"
                  // @ts-ignore: transparent variant does work
                  variant="transparent"
                >
                  <Text size="xs">{abbreviateNumber(stats?.trackCountAllTime ?? 0)}</Text>
                </IconBadge>
                <IconBadge
                  icon={
                    <IconHeart
                      size={14}
                      color={isFavorite ? theme.colors.red[5] : 'currentColor'}
                      fill={isFavorite ? theme.colors.red[5] : 'currentColor'}
                    />
                  }
                  color={isFavorite ? 'red' : theme.colorScheme === 'dark' ? 'dark' : 'gray.0'}
                  p={0}
                  size="lg"
                  // @ts-ignore
                  variant="transparent"
                >
                  <Text size="xs">{abbreviateNumber(stats?.favoriteCountAllTime ?? 0)}</Text>
                </IconBadge>
                <IconBadge
                  icon={<IconMessageCircle2 size={14} />}
                  color={theme.colorScheme === 'dark' ? 'dark' : 'gray.0'}
                  p={0}
                  size="lg"
                  // @ts-ignore
                  variant="transparent"
                >
                  <Text size="xs">{abbreviateNumber(stats?.commentCountAllTime ?? 0)}</Text>
                </IconBadge>
                <IconBadge
                  icon={<IconSwords size={14} />}
                  color={theme.colorScheme === 'dark' ? 'dark' : 'gray.0'}
                  p={0}
                  size="lg"
                  // @ts-ignore
                  variant="transparent"
                >
                  <Text size="xs">{abbreviateNumber(stats?.entryCountAllTime ?? 0)}</Text>
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
