import { Group, Stack, Text, UnstyledButton, useMantineTheme } from '@mantine/core';
import React from 'react';
import dynamic from 'next/dynamic';
import { FeedCard } from '~/components/Cards/FeedCard';
import cardClasses from '~/components/Cards/Cards.module.css';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useRouter } from 'next/router';
import type { BountyGetEntries } from '~/types/router';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import type { Currency } from '~/shared/utils/prisma/enums';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { IconFiles } from '@tabler/icons-react';
import { Reactions } from '~/components/Reaction/Reactions';
import { truncate } from 'lodash-es';
import { constants } from '~/server/common/constants';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import clsx from 'clsx';
import awardedStyles from './BountyEntryCard.module.scss';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const BountyEntryFilesModal = dynamic(() => import('~/components/Bounty/BountyEntryFilesModal'), {
  ssr: false,
});
const openBountyEntryFilesModal = createDialogTrigger(BountyEntryFilesModal);

const IMAGE_CARD_WIDTH = 450;

export function BountyEntryCard({ data, currency, renderActions }: Props) {
  const router = useRouter();
  const theme = useMantineTheme();
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
        className={clsx(
          cardClasses.root,
          cardClasses.noHover,
          'flex h-full flex-col items-stretch justify-stretch'
        )}
      >
        <Stack
          className={clsx({
            [awardedStyles.awardedBanner]: isAwarded,
            [cardClasses.header]: true,
          })}
        >
          <Group justify="space-between" wrap="nowrap">
            {user ? (
              user?.id !== -1 && (
                <UnstyledButton
                  style={{ color: isAwarded ? theme.colors.dark[7] : 'white' }}
                  onClick={(e: React.MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();

                    if (user.username) router.push(`/user/${user.username}`);
                  }}
                >
                  <UserAvatar
                    user={user}
                    avatarProps={{ radius: 'xl', size: 32 }}
                    withUsername
                    subText={
                      <Text size="xs" c="dimmed">
                        <DaysFromNow date={data.createdAt} />
                      </Text>
                    }
                  />
                </UnstyledButton>
              )
            ) : (
              <UserAvatar user={user} />
            )}
            <CurrencyBadge
              currency={currency}
              unitAmount={awardedUnitAmountTotal}
              size="sm"
              p={0}
            />
          </Group>
        </Stack>

        <div className="relative flex-1">
          {image && (
            <ImageGuard2 image={image} connectId={data.id} connectType="bounty">
              {(safe) => (
                <>
                  <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                  <Stack className="absolute right-2 top-2 z-10">
                    <HoverActionButton
                      label="Files"
                      size={30}
                      color="gray.6"
                      variant="filled"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openBountyEntryFilesModal({
                          props: {
                            bountyEntry: data,
                          },
                        });
                      }}
                      keepIconOnHover
                    >
                      <IconFiles stroke={2.5} size={16} />
                    </HoverActionButton>
                    {renderActions && <>{renderActions(data)} </>}
                  </Stack>

                  {safe ? (
                    <EdgeMedia2
                      metadata={image.metadata}
                      src={image.url}
                      name={image.name ?? image.id.toString()}
                      type={image.type}
                      alt={
                        image.meta
                          ? truncate(image.meta.prompt, { length: constants.altTruncateLength })
                          : image.name ?? undefined
                      }
                      width={IMAGE_CARD_WIDTH}
                      className={cardClasses.image}
                      wrapperProps={{ style: { height: 'calc(100% - 60px)' } }}
                      skip={getSkipValue(image)}
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
          className={clsx(cardClasses.contentOverlay, cardClasses.bottom, cardClasses.fullOverlay)}
          gap="sm"
        >
          <Reactions
            entityId={data.id}
            entityType="bountyEntry"
            reactions={reactions}
            className="!justify-start"
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
