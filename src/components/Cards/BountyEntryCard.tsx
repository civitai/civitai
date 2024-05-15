import { createStyles, Group, keyframes, Stack, Text, UnstyledButton } from '@mantine/core';
import React from 'react';
import { FeedCard } from '~/components/Cards/FeedCard';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useRouter } from 'next/router';
import { BountyGetEntries } from '~/types/router';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { IconFiles } from '@tabler/icons-react';
import { openBountyEntryFilesModal } from '~/components/Bounty/BountyEntryFilesModal';
import { Reactions } from '~/components/Reaction/Reactions';
import { truncate } from 'lodash-es';
import { constants } from '~/server/common/constants';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';

const IMAGE_CARD_WIDTH = 450;

const moveBackground = keyframes({
  '0%': {
    backgroundPosition: '0% 50%',
  },
  '50%': {
    backgroundPosition: '100% 50%',
  },
  '100%': {
    backgroundPosition: '0% 50%',
  },
});

const useStyles = createStyles((theme) => ({
  awardedBanner: {
    background: theme.fn.linearGradient(45, theme.colors.yellow[4], theme.colors.yellow[1]),
    animation: `${moveBackground} 5s ease infinite`,
    backgroundSize: '200% 200%',
    color: theme.colors.yellow[7],
  },
}));

export function BountyEntryCard({ data, currency, renderActions }: Props) {
  const { classes: awardedStyles } = useStyles();
  const { classes, cx, theme } = useCardStyles({ aspectRatio: 1 });
  const router = useRouter();
  const { user, images, awardedUnitAmountTotal } = data;
  const image = images?.[0];
  const reactions = data?.reactions ?? [];
  const stats = data?.stats ?? null;
  const isAwarded = awardedUnitAmountTotal > 0;

  return (
    <FeedCard
      aspectRatio="portrait"
      href={`/bounties/${data.bountyId}/entries/${data.id}`}
      pos="relative"
    >
      <div
        className={cx(
          classes.root,
          classes.noHover,
          'flex flex-col justify-stretch items-stretch h-full'
        )}
      >
        <Stack
          className={cx(classes.header, {
            [awardedStyles.awardedBanner]: isAwarded,
          })}
        >
          <Group position="apart" noWrap>
            {user ? (
              user?.id !== -1 && (
                <UnstyledButton
                  sx={{ color: isAwarded ? theme.colors.dark[7] : 'white' }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    router.push(`/user/${user.username}`);
                  }}
                >
                  <UserAvatar
                    user={user}
                    avatarProps={{ radius: 'xl', size: 32 }}
                    withUsername
                    subText={
                      <Text size="xs" color="dimmed">
                        <DaysFromNow date={data.createdAt} />
                      </Text>
                    }
                  />
                </UnstyledButton>
              )
            ) : (
              <UserAvatar user={user} />
            )}

            <Group>
              <CurrencyBadge
                currency={currency}
                unitAmount={awardedUnitAmountTotal}
                size="sm"
                p={0}
              />
            </Group>
          </Group>
        </Stack>

        <div className="relative flex-1">
          {image && (
            <ImageGuard2 image={image} connectId={data.id} connectType="bounty">
              {(safe) => (
                <>
                  <ImageGuard2.BlurToggle className="absolute top-2 left-2 z-10" />
                  <Stack className="absolute top-2 right-2 z-10">
                    <HoverActionButton
                      label="Files"
                      size={30}
                      color="gray.6"
                      variant="filled"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openBountyEntryFilesModal({
                          bountyEntry: data,
                        });
                      }}
                      keepIconOnHover
                    >
                      <IconFiles stroke={2.5} size={16} />
                    </HoverActionButton>
                    {renderActions && <>{renderActions(data)} </>}
                  </Stack>

                  {safe ? (
                    <EdgeMedia
                      src={image.url}
                      name={image.name ?? image.id.toString()}
                      type={image.type}
                      alt={
                        image.meta
                          ? truncate(image.meta.prompt, { length: constants.altTruncateLength })
                          : image.name ?? undefined
                      }
                      width={IMAGE_CARD_WIDTH}
                      className={classes.image}
                      wrapperProps={{ style: { height: 'calc(100% - 60px)' } }}
                    />
                  ) : (
                    <MediaHash {...image} />
                  )}
                </>
              )}
            </ImageGuard2>
          )}
        </div>
        <Stack
          className={cx(classes.contentOverlay, classes.bottom, classes.fullOverlay)}
          spacing="sm"
        >
          <Reactions
            entityId={data.id}
            entityType="bountyEntry"
            reactions={reactions}
            metrics={{
              likeCount: stats?.likeCountAllTime,
              dislikeCount: stats?.dislikeCountAllTime,
              heartCount: stats?.heartCountAllTime,
              laughCount: stats?.laughCountAllTime,
              cryCount: stats?.cryCountAllTime,
              tippedAmountCount: stats?.tippedAmountCountAllTime,
            }}
            targetUserId={data.user?.id}
          />
        </Stack>
      </div>
    </FeedCard>
  );
}

type Props = {
  data: Omit<BountyGetEntries[number], 'files'>;
  currency: Currency;
  renderActions?: (bountyEntry: Omit<BountyGetEntries[number], 'files'>) => React.ReactNode;
};
