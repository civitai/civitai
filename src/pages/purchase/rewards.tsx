import React, { useState } from 'react';
import {
  Center,
  Chip,
  ChipProps,
  Container,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Stack,
  ThemeIcon,
  Title,
  Text,
  Paper,
  createStyles,
  UnstyledButton,
  Modal,
  CloseButton,
  Divider,
  Tabs,
  Button,
  Badge,
  Code,
} from '@mantine/core';
import { IconCheck, IconCircleCheckFilled, IconCloudOff, IconGift } from '@tabler/icons-react';
import {
  isPurchasableRewardActive,
  useMutatePurchasableReward,
  useQueryPurchasableRewards,
  useUserPurchasedRewards,
} from '~/components/PurchasableRewards/purchasableRewards.util';
import { GetPaginatedPurchasableRewardsSchema } from '~/server/schema/purchasable-reward.schema';
import { PurchasableRewardViewMode } from '~/server/common/enums';
import { Currency } from '@prisma/client';
import { getDisplayName } from '~/utils/string-helpers';
import { useDebouncedValue } from '@mantine/hooks';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { constants } from '~/server/common/constants';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { formatDate } from '~/utils/date-helpers';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { AvailableBuzzBadge } from '~/components/Buzz/AvailableBuzzBadge';
import { PurchasableRewardGetPaged } from '~/types/router';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

const chipProps: Partial<ChipProps> = {
  size: 'sm',
  radius: 'xl',
  variant: 'filled',
};

export const useStyles = createStyles((theme) => ({
  rewardCard: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
    borderRadius: theme.radius.md,
    padding: `${theme.spacing.md}px ${theme.spacing.sm}px`,
  },
}));

const RewardDetailsModal = ({
  purchasableReward,
}: {
  purchasableReward: PurchasableRewardGetPaged;
}) => {
  const { purchasedRewards } = useUserPurchasedRewards();
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const isPurchased = purchasedRewards.find(
    (pr) => pr.purchasableReward?.id === purchasableReward.id
  );
  const { classes } = useStyles();
  const { purchasePurchasableReward, purchasingPurchasableReward } = useMutatePurchasableReward();
  const isAvailable = isPurchasableRewardActive(purchasableReward);

  const handlePurchase = async () => {
    try {
      await purchasePurchasableReward({
        purchasableRewardId: purchasableReward.id,
      });

      showSuccessNotification({
        title: 'Reward purchased',
        message: `You have successfully purchased the reward: ${purchasableReward.title}`,
      });
    } catch (err) {
      showErrorNotification({
        title: 'Failed to purchase reward',
        error: new Error('An error occurred while purchasing the reward'),
      });
    }
  };

  return (
    <Modal {...dialog} size="lg" withCloseButton={false} radius="lg">
      <Stack spacing="sm">
        <Group position="apart">
          <Text size="lg" weight="bold">
            Reward Details
          </Text>

          <Group>
            <AvailableBuzzBadge />
            <CloseButton onClick={handleClose} />
          </Group>
        </Group>
        <Divider mx="-lg" />
        <Paper key={purchasableReward.id} className={classes.rewardCard}>
          <Stack spacing="sm">
            {purchasableReward.coverImage && (
              <ImageCSSAspectRatioWrap
                aspectRatio={constants.purchasableRewards.coverImageAspectRatio}
                style={{ width: constants.purchasableRewards.coverImageWidth }}
              >
                <ImageGuard
                  images={[purchasableReward.coverImage]}
                  render={(image) => {
                    return (
                      <ImageGuard.Content>
                        {({ safe }) => (
                          <>
                            {!safe ? (
                              <MediaHash {...image} style={{ width: '100%', height: '100%' }} />
                            ) : (
                              <ImagePreview
                                image={image}
                                edgeImageProps={{ width: 450 }}
                                radius="md"
                                style={{ width: '100%', height: '100%' }}
                                aspectRatio={0}
                              />
                            )}
                            <div style={{ width: '100%', height: '100%' }}>
                              <ImageGuard.ToggleConnect position="top-left" />
                            </div>
                          </>
                        )}
                      </ImageGuard.Content>
                    );
                  }}
                />
              </ImageCSSAspectRatioWrap>
            )}
            <Text size="lg">{purchasableReward.title}</Text>
            <div>
              {isPurchased ? (
                <Group spacing={8}>
                  <ThemeIcon color="teal" radius="xl" size="sm">
                    <IconCheck size={14} />
                  </ThemeIcon>
                  <Text color="teal" size="sm" weight="bold">
                    Purchased
                  </Text>
                </Group>
              ) : isAvailable ? (
                <BuzzTransactionButton
                  loading={purchasingPurchasableReward}
                  buzzAmount={purchasableReward.unitPrice}
                  radius="xl"
                  onPerformTransaction={handlePurchase}
                  label="Unlock now"
                  color="yellow.7"
                />
              ) : (
                <Group spacing={8}>
                  <ThemeIcon color="red" radius="xl" size="sm">
                    <IconCircleCheckFilled size={14} />
                  </ThemeIcon>
                  <Text color="red" size="sm" weight="bold">
                    Not available
                  </Text>
                </Group>
              )}
            </div>
          </Stack>
        </Paper>
        <Tabs variant="pills" radius="xl" defaultValue="about" color="gray">
          <Tabs.List>
            <Tabs.Tab value="about">About</Tabs.Tab>
            <Tabs.Tab value="redeemDetails">How to redeem</Tabs.Tab>
            <Tabs.Tab value="termsOfUse">Terms of use</Tabs.Tab>
            {isPurchased ? <Tabs.Tab value="redeem">Redeem</Tabs.Tab> : null}
          </Tabs.List>
          <Tabs.Panel value="about" pt="md">
            <RenderHtml html={purchasableReward.about} />
          </Tabs.Panel>
          <Tabs.Panel value="redeemDetails" pt="md">
            <RenderHtml html={purchasableReward.redeemDetails} />
          </Tabs.Panel>
          <Tabs.Panel value="termsOfUse" pt="md">
            <RenderHtml html={purchasableReward.termsOfUse} />
          </Tabs.Panel>
          {isPurchased && (
            <Tabs.Panel value="redeem" pt="md">
              <Stack>
                <Text size="sm" color="dimmed">
                  Use the code or link provided below to redeem your reward. If you need more
                  information on how to redeem your reward, check the &rsquo;How to redeem&rsquo;
                  section.
                </Text>
                <Code p="md">{isPurchased.code}</Code>
              </Stack>
            </Tabs.Panel>
          )}
        </Tabs>
      </Stack>
    </Modal>
  );
};

export default function PurchaseRewards() {
  const [filters, setFilters] = useState<Omit<GetPaginatedPurchasableRewardsSchema, 'limit'>>({
    page: 1,
    mode: PurchasableRewardViewMode.Available,
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);
  const { purchasableRewards, pagination, isLoading, isRefetching } =
    useQueryPurchasableRewards(debouncedFilters);
  const { purchasedRewards } = useUserPurchasedRewards();

  const { classes } = useStyles();

  return (
    <Container size="md" mb="lg">
      <Stack>
        <Group noWrap>
          <Title>Rewards</Title>
          <IconGift size={32} style={{ marginTop: '8px' }} />
        </Group>
        <Chip.Group
          spacing={8}
          value={filters.mode}
          onChange={(mode: PurchasableRewardViewMode) => {
            setFilters((f) => ({
              ...f,
              mode,
            }));
          }}
        >
          {Object.values(PurchasableRewardViewMode).map((type, index) => (
            <Chip key={index} value={type} {...chipProps}>
              {getDisplayName(type)}
            </Chip>
          ))}
        </Chip.Group>
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : !!purchasableRewards.length ? (
          <Stack>
            <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
            {purchasableRewards.map((reward) => {
              const isPurchased = purchasedRewards.some(
                (pr) => pr.purchasableReward?.id === reward.id
              );

              return (
                <UnstyledButton
                  key={reward.id}
                  className={classes.rewardCard}
                  onClick={() => {
                    dialogStore.trigger({
                      component: RewardDetailsModal,
                      props: { purchasableReward: reward },
                    });
                  }}
                >
                  <Group spacing="xl" align="start">
                    {reward.coverImage && (
                      <ImageCSSAspectRatioWrap
                        aspectRatio={constants.purchasableRewards.coverImageAspectRatio}
                        style={{ width: constants.purchasableRewards.coverImageWidth }}
                      >
                        <ImageGuard
                          images={[reward.coverImage]}
                          render={(image) => {
                            return (
                              <ImageGuard.Content>
                                {({ safe }) => (
                                  <>
                                    {!safe ? (
                                      <MediaHash
                                        {...image}
                                        style={{ width: '100%', height: '100%' }}
                                      />
                                    ) : (
                                      <ImagePreview
                                        image={image}
                                        edgeImageProps={{ width: 450 }}
                                        radius="md"
                                        style={{ width: '100%', height: '100%' }}
                                        aspectRatio={0}
                                      />
                                    )}
                                    <div style={{ width: '100%', height: '100%' }}>
                                      <ImageGuard.ToggleConnect position="top-left" />
                                    </div>
                                  </>
                                )}
                              </ImageGuard.Content>
                            );
                          }}
                        />
                      </ImageCSSAspectRatioWrap>
                    )}
                    <Stack style={{ flex: 1 }} spacing={0}>
                      <Group noWrap position="apart">
                        <Text size="xs" color="dimmed">
                          Added on {formatDate(reward.createdAt)}
                        </Text>
                        {isPurchased ? (
                          <Badge color="green" variant="light">
                            Purchased
                          </Badge>
                        ) : (
                          <CurrencyBadge currency={Currency.BUZZ} unitAmount={reward.unitPrice} />
                        )}
                      </Group>
                      <Text size="xl">{reward.title}</Text>
                      {reward.availableCount && (
                        <Text size="sm" color="dimmed">
                          {reward.availableCount - reward._count.purchases} out of{' '}
                          {reward.availableCount} available
                        </Text>
                      )}
                      {reward.availableFrom && reward.availableTo && (
                        <Text size="xs" color="dimmed">
                          Available from {formatDate(reward.availableFrom)} to{' '}
                          {formatDate(reward.availableTo)}
                        </Text>
                      )}
                    </Stack>
                  </Group>
                </UnstyledButton>
              );
            })}

            {pagination && pagination.totalPages > 1 && (
              <Group position="apart">
                <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
                <Pagination
                  page={filters.page}
                  onChange={(page) => setFilters((curr) => ({ ...curr, page }))}
                  total={pagination.totalPages}
                />
              </Group>
            )}
          </Stack>
        ) : (
          <Stack align="center">
            <ThemeIcon size={62} radius={100}>
              <IconCloudOff />
            </ThemeIcon>
            <Text align="center">Looks like no purchasable rewards are available.</Text>
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
