import { Badge, BadgeProps, HoverCard, Text, ThemeIcon } from '@mantine/core';
import { Currency } from '~/shared/utils/prisma/enums';
import {
  IconAlertCircle,
  IconClockHour4,
  IconHeart,
  IconMessageCircle2,
  IconSwords,
  IconViewfinder,
} from '@tabler/icons-react';
import React from 'react';
import { useBountyEngagement } from '~/components/Bounty/bounty.utils';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { BountyGetAll } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { BountyContextMenu } from '../Bounty/BountyContextMenu';
import { DaysFromNow } from '../Dates/DaysFromNow';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';

const sharedBadgeProps: Omit<BadgeProps, 'children'> = {
  radius: 'xl',
  variant: 'filled',
  px: 8,
  h: 26,
  tt: 'capitalize',
};

export function BountyCard({ data }: Props) {
  const { classes, cx, theme } = useCardStyles({ aspectRatio: 1 });
  const { id, name, images, type, expiresAt, stats, complete } = data;
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
    <AspectRatioImageCard
      href={`/bounties/${id}/${slugit(name)}`}
      aspectRatio="square"
      contentType="bounty"
      contentId={id}
      image={image}
      header={
        <div className="flex w-full justify-between">
          <div className="flex gap-1">
            {type && (
              <Badge className={cx(classes.infoChip, classes.chip)} variant="light" radius="xl">
                <Text color="white" size="xs" transform="capitalize">
                  {getDisplayName(type)}
                </Text>
              </Badge>
            )}
            {deadlineBadge}
          </div>
          <BountyContextMenu bounty={data} position="bottom-end" withinPortal />
        </div>
      }
      footerGradient
      footer={
        <div className="flex w-full flex-col gap-2">
          <UserAvatarSimple {...data.user} />
          <div className="flex items-start justify-between gap-2"></div>
          <div className="flex items-start justify-between gap-2">
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
                  <div>
                    <Text color="yellow" weight={590}>
                      Pending scan
                    </Text>
                    <Text size="sm">
                      This bounty won&apos;t be visible publicly until it has completed the image
                      scan process
                    </Text>
                  </div>
                </HoverCard.Dropdown>
              </HoverCard>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
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
              <div className="flex items-center gap-2">
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
              </div>
            </Badge>
          </div>
        </div>
      }
    />
  );
}

type Props = { data: BountyGetAll[number] };
