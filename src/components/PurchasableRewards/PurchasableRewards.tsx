import React, { useState } from 'react';
import {
  Center,
  Chip,
  ChipProps,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Stack,
  ThemeIcon,
  Title,
  Text,
  Paper,
  UnstyledButton,
  Modal,
  CloseButton,
  Divider,
  Tabs,
  Badge,
  Code,
  Grid,
  Box,
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
import { Currency } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';
import { useDebouncedValue } from '@mantine/hooks';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
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
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import classes from './PurchasableRewards.module.scss';
import clsx from 'clsx';

const chipProps: Partial<ChipProps> = {
  size: 'sm',
  radius: 'xl',
  variant: 'filled',
};

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
  const { purchasePurchasableReward, purchasingPurchasableReward } = useMutatePurchasableReward();
  const isAvailable = isPurchasableRewardActive(purchasableReward);
  const terms = purchasableReward.termsOfUse == '<p>N/A</p>' ? null : purchasableReward.termsOfUse;

  const [selectedTab, setSelectedTab] = useState<string | null>(isPurchased ? 'redeem' : 'about');

  const handlePurchase = async () => {
    try {
      await purchasePurchasableReward({
        purchasableRewardId: purchasableReward.id,
      });

      setSelectedTab('redeem');

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

  const image = purchasableReward.coverImage;

  return (
    <Modal {...dialog} size="md" withCloseButton={false} radius="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text size="lg" fw="bold">
            Reward Details
          </Text>

          <Group>
            <AvailableBuzzBadge />
            <CloseButton onClick={handleClose} />
          </Group>
        </Group>
        <Divider mx="-lg" />
        <Paper key={purchasableReward.id} className={classes.rewardCard} my="sm">
          <Stack gap="sm">
            {image && (
              <ImageCSSAspectRatioWrap
                aspectRatio={constants.purchasableRewards.coverImageAspectRatio}
                style={{ width: constants.purchasableRewards.coverImageWidth }}
              >
                <ImageGuard2 image={image}>
                  {(safe) => (
                    <>
                      <ImageGuard2.BlurToggle
                        className="absolute left-2 top-2 z-10"
                        sfwClassName="hidden"
                      />
                      {!safe ? (
                        <MediaHash {...image} style={{ width: '100%', height: '100%' }} />
                      ) : (
                        <ImagePreview
                          image={image}
                          edgeImageProps={{ width: 450 }}
                          radius="md"
                          style={{ width: '100%', height: '100%' }}
                          // aspectRatio={0}
                        />
                      )}
                    </>
                  )}
                </ImageGuard2>
              </ImageCSSAspectRatioWrap>
            )}
            <Text size="lg">{purchasableReward.title}</Text>
            <div>
              {isPurchased ? (
                <Group gap={8}>
                  <ThemeIcon color="teal" radius="xl" size="sm">
                    <IconCheck size={14} />
                  </ThemeIcon>
                  <Text c="teal" size="sm" fw="bold">
                    Purchased
                  </Text>
                </Group>
              ) : isAvailable ? (
                <BuzzTransactionButton
                  loading={purchasingPurchasableReward}
                  buzzAmount={purchasableReward.unitPrice}
                  radius="xl"
                  onPerformTransaction={handlePurchase}
                  label="Unlock Now"
                  size="md"
                />
              ) : (
                <Group gap={8}>
                  <ThemeIcon color="red" radius="xl" size="sm">
                    <IconCircleCheckFilled size={14} />
                  </ThemeIcon>
                  <Text c="red" size="sm" fw="bold">
                    Not available
                  </Text>
                </Group>
              )}
            </div>
          </Stack>
        </Paper>
        <Tabs
          variant="pills"
          radius="xl"
          value={selectedTab}
          onChange={setSelectedTab}
          color="gray"
          styles={{
            tab: {
              padding: '6px 12px',
              fontWeight: 500,
            },
          }}
        >
          <Tabs.List>
            <Tabs.Tab value="about">About</Tabs.Tab>
            <Tabs.Tab value="redeemDetails">How to Redeem</Tabs.Tab>
            {terms && <Tabs.Tab value="termsOfUse">Terms of Use</Tabs.Tab>}
            {isPurchased ? <Tabs.Tab value="redeem">Redeem</Tabs.Tab> : null}
          </Tabs.List>
          <Tabs.Panel value="about" pt="sm">
            <RenderHtml
              html={purchasableReward.about}
              className={clsx(classes.renderHtmlYoutube, 'text-sm')}
            />
          </Tabs.Panel>
          <Tabs.Panel value="redeemDetails" pt="sm">
            <RenderHtml html={purchasableReward.redeemDetails} className="text-sm" />
          </Tabs.Panel>
          {terms && (
            <Tabs.Panel value="termsOfUse" pt="sm">
              <RenderHtml html={purchasableReward.termsOfUse} className="text-sm" />
            </Tabs.Panel>
          )}
          {isPurchased && (
            <Tabs.Panel value="redeem" pt="sm">
              <Stack>
                <Text size="sm">
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

const PurchasableRewardListItem = ({
  purchasableReward,
}: {
  purchasableReward: PurchasableRewardGetPaged;
}) => {
  const { purchasedRewards } = useUserPurchasedRewards();
  const isPurchased = purchasedRewards.some(
    (pr) => pr.purchasableReward?.id === purchasableReward.id
  );

  const image = purchasableReward.coverImage;

  return (
    <UnstyledButton
      className={classes.rewardCard}
      onClick={() => {
        dialogStore.trigger({
          component: RewardDetailsModal,
          props: { purchasableReward },
        });
      }}
    >
      <Group gap="xl" align="start">
        {image && (
          <ImageCSSAspectRatioWrap
            aspectRatio={constants.purchasableRewards.coverImageAspectRatio}
            style={{ width: constants.purchasableRewards.coverImageWidth }}
          >
            <ImageGuard2 image={image}>
              {(safe) => (
                <>
                  <ImageGuard2.BlurToggle
                    className="absolute left-2 top-2 z-10"
                    sfwClassName="hidden"
                  />
                  {!safe ? (
                    <MediaHash {...image} style={{ width: '100%', height: '100%' }} />
                  ) : (
                    <ImagePreview
                      image={image}
                      edgeImageProps={{ width: 450 }}
                      radius="md"
                      style={{ width: '100%', height: '100%' }}
                      // aspectRatio={0}
                    />
                  )}
                </>
              )}
            </ImageGuard2>
          </ImageCSSAspectRatioWrap>
        )}
        <Stack style={{ flex: 1 }} gap={0}>
          <Group wrap="nowrap" justify="space-between">
            <Text size="xs" c="dimmed">
              Added on {formatDate(purchasableReward.createdAt)}
            </Text>
            {isPurchased ? (
              <Badge color="green" variant="light" radius="xl">
                Purchased
              </Badge>
            ) : (
              <CurrencyBadge currency={Currency.BUZZ} unitAmount={purchasableReward.unitPrice} />
            )}
          </Group>
          <Text size="xl">{purchasableReward.title}</Text>
          {purchasableReward.availableCount && (
            <Text size="sm" c="dimmed">
              {purchasableReward.availableCount - purchasableReward._count.purchases} out of{' '}
              {purchasableReward.availableCount} available
            </Text>
          )}
          {purchasableReward.availableFrom && purchasableReward.availableTo && (
            <Text size="xs" c="dimmed">
              Available from {formatDate(purchasableReward.availableFrom)} to{' '}
              {formatDate(purchasableReward.availableTo)}
            </Text>
          )}
        </Stack>
      </Group>
    </UnstyledButton>
  );
};

const PurchasableRewardCard = ({
  purchasableReward,
}: {
  purchasableReward: PurchasableRewardGetPaged;
}) => {
  const { purchasedRewards } = useUserPurchasedRewards();
  const isPurchased = purchasedRewards.some(
    (pr) => pr.purchasableReward?.id === purchasableReward.id
  );

  const image = purchasableReward.coverImage;

  return (
    <Grid.Col
      span={{
        base: 12,
        sm: 6,
        md: 3,
      }}
    >
      <UnstyledButton
        className={classes.rewardCard}
        onClick={() => {
          dialogStore.trigger({
            component: RewardDetailsModal,
            props: { purchasableReward },
          });
        }}
      >
        <Stack style={{ flex: 1, height: '100%' }}>
          {image && (
            <ImageCSSAspectRatioWrap
              aspectRatio={constants.purchasableRewards.coverImageAspectRatio}
              style={{ width: '100%' }}
            >
              <ImageGuard2 image={image}>
                {(safe) => (
                  <>
                    <ImageGuard2.BlurToggle
                      className="absolute left-2 top-2 z-10"
                      sfwClassName="hidden"
                    />
                    {!safe ? (
                      <MediaHash {...image} style={{ width: '100%', height: '100%' }} />
                    ) : (
                      <ImagePreview
                        image={image}
                        edgeImageProps={{ width: 450 }}
                        // radius="md"
                        style={{ width: '100%', height: '100%' }}
                        // aspectRatio={0}
                      />
                    )}
                  </>
                )}
              </ImageGuard2>
            </ImageCSSAspectRatioWrap>
          )}
          <Stack gap={0}>
            <Text size="xs" c="dimmed">
              Added on {formatDate(purchasableReward.createdAt)}
            </Text>
            <Text size="xl">{purchasableReward.title}</Text>
          </Stack>
          <Stack gap={0}>
            {purchasableReward.availableCount && (
              <Text size="sm" c="dimmed">
                {purchasableReward.availableCount - purchasableReward._count.purchases} out of{' '}
                {purchasableReward.availableCount} available
              </Text>
            )}
            {purchasableReward.availableFrom && purchasableReward.availableTo && (
              <Text size="xs" c="dimmed">
                Available from {formatDate(purchasableReward.availableFrom)} to{' '}
                {formatDate(purchasableReward.availableTo)}
              </Text>
            )}
          </Stack>
          <Box mt="auto">
            {isPurchased ? (
              <Badge color="green" variant="light" radius="xl">
                Purchased
              </Badge>
            ) : (
              <CurrencyBadge
                currency={Currency.BUZZ}
                unitAmount={purchasableReward.unitPrice}
                color="yellow.7"
                variant="light"
              />
            )}
          </Box>
        </Stack>
      </UnstyledButton>
    </Grid.Col>
  );
};

export function PurchasableRewards() {
  const [filters, setFilters] = useState<Omit<GetPaginatedPurchasableRewardsSchema, 'limit'>>({
    page: 1,
    mode: PurchasableRewardViewMode.Available,
  });
  const { purchasableRewards, pagination, isLoading, isRefetching } =
    useQueryPurchasableRewards(filters);
  const { purchasedRewards } = useUserPurchasedRewards();

  if (
    purchasableRewards?.length === 0 &&
    filters.mode === PurchasableRewardViewMode.Available &&
    purchasedRewards.length === 0
  ) {
    // If there are no purchasable rewards and the user has not purchased any rewards, we don't
    // need to display anything.
    return null;
  }

  return (
    <Stack>
      <Stack gap={4}>
        <Title order={2}>Deals &amp; Coupons</Title>
        <Text>{`Spend some Buzz to get special deals and coupons`}</Text>
      </Stack>
      <Chip.Group
        value={filters.mode}
        onChange={(mode) => {
          setFilters((f) => ({
            ...f,
            mode: mode as PurchasableRewardViewMode,
          }));
        }}
      >
        <Group gap={8}>
          {Object.values(PurchasableRewardViewMode).map((type, index) => (
            <Chip key={index} value={type} {...chipProps}>
              <span>{getDisplayName(type)}</span>
            </Chip>
          ))}
        </Group>
      </Chip.Group>
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !!purchasableRewards.length ? (
        <Stack>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          {filters.mode === PurchasableRewardViewMode.Available && (
            <Grid>
              {purchasableRewards.map((purchasableReward) => {
                return (
                  <PurchasableRewardCard
                    purchasableReward={purchasableReward}
                    key={purchasableReward.id}
                  />
                );
              })}
            </Grid>
          )}

          {filters.mode === PurchasableRewardViewMode.Purchased && (
            <Stack style={{ maxWidth: 800 }}>
              {purchasableRewards.map((purchasableReward) => {
                return (
                  <PurchasableRewardListItem
                    purchasableReward={purchasableReward}
                    key={purchasableReward.id}
                  />
                );
              })}
            </Stack>
          )}

          {pagination && pagination.totalPages > 1 && (
            <Group justify="space-between">
              <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
              <Pagination
                value={filters.page}
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
  );
}
