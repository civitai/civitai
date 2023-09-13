import { Badge, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import React from 'react';
import { FeedCard } from '~/components/Cards/FeedCard';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useRouter } from 'next/router';
import { BountyEntryGetById } from '~/types/router';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { IconFiles } from '@tabler/icons-react';
import { openBountyEntryFilesModal } from '~/components/Bounty/BountyEntryFilesModal';
import { Reactions } from '~/components/Reaction/Reactions';

const IMAGE_CARD_WIDTH = 332;

export function BountyEntryCard({ data, currency, renderActions }: Props) {
  const { classes, cx } = useCardStyles({ aspectRatio: 1 });
  const router = useRouter();
  const { user, images, awardedUnitAmountTotal } = data;
  // TODO.bounty: applyUserPreferences on bounty entry image
  const cover = images?.[0];
  const reactions = data?.reactions ?? [];
  const stats = data?.stats ?? null;

  return (
    <FeedCard aspectRatio="square" href={`/bounties/${data.bountyId}/entries/${data.id}`}>
      <div className={cx(classes.root, classes.withHeader, classes.noHover)}>
        <Stack className={classes.header}>
          <Group position="apart" noWrap>
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
                  <UserAvatar
                    user={user}
                    avatarProps={{ radius: 'md', size: 32 }}
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
                    </Group>

                    <Stack>
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
            }}
          />
        </Stack>
      </div>
    </FeedCard>
  );
}

type Props = {
  data: Omit<BountyEntryGetById, 'files'>;
  currency: Currency;
  renderActions?: (bountyEntry: Omit<BountyEntryGetById, 'files'>) => React.ReactNode;
};
