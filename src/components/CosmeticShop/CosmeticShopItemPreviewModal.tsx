import { Center, Grid, Modal, Stack } from '@mantine/core';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useMutateCosmeticShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CosmeticSample } from '~/pages/moderator/cosmetic-store/cosmetics';
import { CosmeticShopItemGetById } from '~/types/router';
import { showSuccessNotification } from '~/utils/notifications';

type Props = { shopItem: CosmeticShopItemGetById };

export const CosmeticShopItemPreviewModal = ({ shopItem }: Props) => {
  const dialog = useDialogContext();
  const { cosmetic } = shopItem;
  const { purchaseShopItem, purchasingShopItem } = useMutateCosmeticShop();

  const handlePurchaseShopItem = async () => {
    try {
      await purchaseShopItem({ shopItemId: shopItem.id });
      showSuccessNotification({
        message: 'Your purchase has been completed and your cosmetic is now available to equip',
      });
      dialog.onClose();
    } catch (error) {
      // Do nothing, handled within the hook
    }
  };

  return (
    <Modal {...dialog} title="Preview cosmetic">
      <Stack>
        <Grid>
          <Grid.Col span={12} md={6}>
            <Stack spacing="lg">
              <Center my="lg">
                <CosmeticSample cosmetic={cosmetic} size="lg" />
              </Center>
              <BuzzTransactionButton
                disabled={purchasingShopItem}
                loading={purchasingShopItem}
                buzzAmount={shopItem.unitAmount}
                radius="md"
                onPerformTransaction={handlePurchaseShopItem}
                label="Purchase"
                color="yellow.7"
              />
            </Stack>
          </Grid.Col>
          <Grid.Col span={12} md={6}></Grid.Col>
        </Grid>
      </Stack>
    </Modal>
  );
};
