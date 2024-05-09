import {
  Box,
  Center,
  Grid,
  Modal,
  Stack,
  createStyles,
  Text,
  CloseButton,
  Group,
  Button,
  Loader,
  ActionIcon,
  Anchor,
  UnstyledButton,
} from '@mantine/core';
import { CosmeticType } from '@prisma/client';
import { useRouter } from 'next/router';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useMutateCosmeticShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import {
  useEquipContentDecoration,
  useEquipProfileDecoration,
  useQueryUserCosmetics,
} from '~/components/Cosmetics/cosmetics.util';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CosmeticPreview, CosmeticSample } from '~/pages/moderator/cosmetic-store/cosmetics';
import { CosmeticShopItemGetById } from '~/types/router';
import { showSuccessNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';
import { IconAlertTriangleFilled } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { NotificationToggle } from '~/components/Notifications/NotificationToggle';

type Props = { shopItem: CosmeticShopItemGetById };

const useStyles = createStyles((theme) => ({
  sample: {
    padding: theme.spacing.lg,
  },
  preview: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
    padding: theme.spacing.lg,
  },
  text: {
    color: theme.colorScheme === 'dark' ? theme.colors.white : theme.colors.black,
  },
}));

export const CosmeticShopItemPurchaseCompleteModal = ({
  shopItem,
  userCosmetic,
}: Props & { userCosmetic: { cosmeticId: number; claimKey: string } }) => {
  const dialog = useDialogContext();
  const { cosmetic } = shopItem;
  const { classes, theme } = useStyles();
  const currentUser = useCurrentUser();
  const { equip, isLoading } = useEquipProfileDecoration();
  const router = useRouter();

  const handleApplyDecoration = async () => {
    if (cosmetic.type === CosmeticType.ContentDecoration) {
      router.push(`/user/${currentUser?.username}`);
    } else {
      // Apply now...
      await equip({
        id: userCosmetic.cosmeticId,
      });

      showSuccessNotification({
        message: 'Your cosmetic has been applied to your profile!',
      });
    }

    dialog.onClose();
  };

  return (
    <Modal {...dialog} size="md" withCloseButton={false} radius="lg">
      <Stack spacing="xl" px="md">
        <Group position="apart">
          <Text className={classes.text}>You got a shiny new thing!</Text>
          <CloseButton onClick={dialog.onClose} />
        </Group>

        <Box className={classes.preview} style={{ borderRadius: theme.radius.lg }}>
          <CosmeticPreview cosmetic={cosmetic} />
        </Box>

        <Stack spacing={4}>
          {cosmetic.type === CosmeticType.ContentDecoration && (
            <Text size="xs" color="dimmed" align="center">
              This decoration is now available to apply to your content. You can select which piece
              to apply it on from your profile.
            </Text>
          )}
          <Button radius="xl" mx="auto" onClick={handleApplyDecoration} loading={isLoading}>
            {cosmetic.type === CosmeticType.ContentDecoration ? 'Go to my profile' : 'Apply now'}
          </Button>
          <NotificationToggle type="cosmetic-shop-item-added-to-section">
            {({ onToggle, isEnabled }) =>
              isEnabled ? null : (
                <Group>
                  <Text size="xs" align="center">
                    Do not miss out on new items in the shop!
                    <UnstyledButton onClick={onToggle}>
                      <Text size="xs" component="span" color="blue">
                        Click here to Enable notifications
                      </Text>
                    </UnstyledButton>
                  </Text>
                </Group>
              )
            }
          </NotificationToggle>
        </Stack>
      </Stack>
    </Modal>
  );
};

export const CosmeticShopItemPreviewModal = ({ shopItem }: Props) => {
  const dialog = useDialogContext();
  const { cosmetic } = shopItem;
  const { purchaseShopItem, purchasingShopItem } = useMutateCosmeticShop();
  const { classes } = useStyles();
  const { data: userCosmetics, isLoading } = useQueryUserCosmetics();
  const { equip, isLoading: isEquipping } = useEquipProfileDecoration();
  const hasCosmetic = Object.values(userCosmetics ?? {})
    .flat()
    .some(({ id }) => id === cosmetic.id);
  const canPurchase = cosmetic.type === CosmeticType.ContentDecoration || !hasCosmetic;
  const isAvailable =
    (shopItem.availableQuantity === null || shopItem.availableQuantity > 0) &&
    (shopItem.availableFrom === null || dayjs(shopItem.availableFrom).isBefore(dayjs()));

  const handlePurchaseShopItem = async () => {
    try {
      const userCosmetic = await purchaseShopItem({ shopItemId: shopItem.id });

      showSuccessNotification({
        message: 'Your purchase has been completed and your cosmetic is now available to equip',
      });
      dialog.onClose();
      dialogStore.trigger({
        component: CosmeticShopItemPurchaseCompleteModal,
        props: { shopItem, userCosmetic },
      });
    } catch (error) {
      // Do nothing, handled within the hook
    }
  };

  const handleEquipDecoration = async () => {
    await equip({
      id: cosmetic.id,
    });

    showSuccessNotification({
      message: 'Your cosmetic has been applied to your profile!',
    });

    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      size="xl"
      withCloseButton={false}
      radius="lg"
      styles={{
        modal: {
          padding: '0 !important',
          overflow: 'hidden',
        },
      }}
    >
      <Grid m={0}>
        <Grid.Col span={12} md={5} className={classes.sample}>
          <Stack spacing="lg" px="md" h="100%">
            <Group position="apart" noWrap>
              <Text className={classes.text} size="sm">
                {getDisplayName(cosmetic.type)}
              </Text>
              <CloseButton className="show-mobile" onClick={dialog.onClose} />
            </Group>
            <Center my="auto" h={250}>
              <CosmeticSample cosmetic={cosmetic} size="lg" />
            </Center>
            <Text className={classes.text} mt="auto" weight="bold" size="lg">
              {shopItem.title}
            </Text>
            {isLoading && (
              <Center>
                <Loader variant="bars" />
              </Center>
            )}
            {!isLoading && (
              <>
                {canPurchase ? (
                  <BuzzTransactionButton
                    disabled={purchasingShopItem || !isAvailable}
                    loading={purchasingShopItem}
                    buzzAmount={shopItem.unitAmount}
                    radius="xl"
                    onPerformTransaction={handlePurchaseShopItem}
                    label="Purchase"
                    color="yellow.7"
                  />
                ) : (
                  <Stack spacing={4}>
                    <Button radius="xl" onClick={handleEquipDecoration} loading={isEquipping}>
                      Equip now
                    </Button>
                    <Text size="sm" align="center" color="dimmed">
                      You already own this cosmetic
                    </Text>
                  </Stack>
                )}
              </>
            )}
            {cosmetic.type === CosmeticType.ContentDecoration && (
              <Group spacing="xs" noWrap>
                <Text color="yellow">
                  <IconAlertTriangleFilled />
                </Text>

                <Text size="xs" color="yellow" lh={1.3}>
                  This cosmetic is an <u>equippable</u>. It can only be applied to <u>one</u> piece
                  of content at a time.
                </Text>
              </Group>
            )}
          </Stack>
        </Grid.Col>
        <Grid.Col span={12} md={7} className={classes.preview}>
          <Stack spacing={0} h={0} align="flex-end" className="hide-mobile">
            <CloseButton onClick={dialog.onClose} />
          </Stack>
          <Stack px="md" h="100%" justify="center">
            <CosmeticPreview cosmetic={cosmetic} />
          </Stack>
        </Grid.Col>
      </Grid>
    </Modal>
  );
};
