import {
  Badge,
  Box,
  Button,
  Center,
  CloseButton,
  Grid,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import { useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { PayWithSelector } from '~/components/CosmeticShop/PayWithSelector';
import type { PayWithOption } from '~/components/CosmeticShop/PayWithSelector';
import { CosmeticThumb } from '~/components/CreatorShop/CosmeticThumb';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useMutateCosmeticShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { showSuccessNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

/**
 * A pack's own modal rather than a branch inside the single-item one: nearly
 * every line of that component reads `shopItem.cosmetic`, which a pack does not
 * have.
 *
 * Showing the contents is not decoration. A pack may be bought regardless of
 * what the buyer already owns (D16), and seeing what's inside beforehand is the
 * stated mitigation for that.
 */
export const CosmeticPackPreviewModal = ({
  shopItemId,
  viaShopUserId,
}: {
  shopItemId: number;
  viaShopUserId?: number;
}) => {
  const dialog = useDialogContext();
  const { data: pack, isLoading } = trpc.creatorShop.getPack.useQuery({ id: shopItemId });
  const { purchaseShopItem, purchasingShopItem } = useMutateCosmeticShop();
  const [domainType] = useAvailableBuzz();
  const [payWith, setPayWith] = useState<PayWithOption>('default');

  const acceptsBlue = !!pack?.meta.acceptsBlueBuzz;
  const accountTypes: BuzzSpendType[] =
    !acceptsBlue || payWith === 'default' ? [domainType] : ['blue', domainType];
  const unavailable = (pack?.unavailableCount ?? 0) > 0;

  const handlePurchase = async () => {
    if (!pack) return;
    try {
      await purchaseShopItem({
        shopItemId: pack.id,
        viaShopUserId,
        payWith: acceptsBlue ? payWith : undefined,
      });
      showSuccessNotification({ message: 'Pack purchased — every item is now in your inventory' });
      dialog.onClose();
    } catch {
      // Handled in the hook.
    }
  };

  return (
    <Modal {...dialog} size="xl" withCloseButton={false} radius="lg" classNames={{ body: 'p-0' }}>
      <Grid classNames={{ inner: 'my-0' }}>
        <Grid.Col span={{ base: 12, md: 5 }} p="lg">
          <Stack gap="lg" px="md" h="100%">
            <Group justify="space-between" wrap="nowrap">
              <Text className="text-black dark:text-white" size="sm">
                Pack
              </Text>
              <CloseButton className="show-mobile" onClick={dialog.onClose} />
            </Group>
            <Center my="auto" h={250}>
              {pack?.meta.coverUrl && (
                <EdgeMedia src={pack.meta.coverUrl} width={450} alt={pack.title} />
              )}
            </Center>
            <Text className="text-black dark:text-white" mt="auto" fw="bold" size="lg">
              {pack?.title}
            </Text>
            {isLoading && (
              <Center>
                <Loader type="bars" />
              </Center>
            )}
            {pack && (
              <Stack gap={6}>
                {pack.discount > 0 && (
                  <Text size="xs" c="dimmed">
                    You already own part of this pack, so {numberWithCommas(pack.discount)} Buzz of
                    it is discounted.
                  </Text>
                )}
                {pack.selfAuthored > 0 && (
                  <Text size="xs" c="dimmed">
                    You made {numberWithCommas(pack.selfAuthored)} Buzz worth of what&apos;s in
                    here, so you aren&apos;t charged for it.
                  </Text>
                )}
                {unavailable && (
                  <Text size="xs" c="yellow">
                    Something in this pack is no longer for sale, so it can&apos;t be bought right
                    now.
                  </Text>
                )}
                {acceptsBlue && (
                  <PayWithSelector value={payWith} onChange={setPayWith} domainType={domainType} />
                )}
                <BuzzTransactionButton
                  disabled={purchasingShopItem || unavailable}
                  loading={purchasingShopItem}
                  buzzAmount={pack.amountDue}
                  radius="xl"
                  onPerformTransaction={handlePurchase}
                  label="Purchase pack"
                  accountTypes={accountTypes}
                  showTypePct={acceptsBlue && payWith === 'blue-first'}
                />
              </Stack>
            )}
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 7 }} p="lg" className="bg-gray-0 dark:bg-dark-8">
          <Stack gap={0} h={0} align="flex-end" className="hide-mobile">
            <CloseButton onClick={dialog.onClose} />
          </Stack>
          <Stack px="md" gap="xs">
            <Text fw={600} size="sm">
              What&apos;s inside ({pack?.members.length ?? 0})
            </Text>
            {pack?.members.map((member) => (
              <Paper key={member.cosmeticId} withBorder radius="md" p="xs">
                <Group gap="xs" wrap="nowrap" align="center">
                  <CosmeticThumb data={member.data} name={member.name} />
                  <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                    <Text size="sm" fw={600} lineClamp={1}>
                      {member.name}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {getDisplayName(member.type)}
                      {member.creatorUsername ? ` · by @${member.creatorUsername}` : ''}
                    </Text>
                  </Stack>
                  <Stack gap={2} align="flex-end">
                    <Text size="xs">{numberWithCommas(member.listPrice)} Buzz</Text>
                    {member.owned && (
                      <Badge size="xs" variant="light" color={member.consumable ? 'blue' : 'gray'}>
                        {/* Owning a consumable is not a duplicate — the purchase
                            adds uses (D23), which is why it isn't discounted. */}
                        {member.consumable ? 'Adds uses' : 'Owned'}
                      </Badge>
                    )}
                  </Stack>
                </Group>
              </Paper>
            ))}
            {!!pack?.unavailableCount && (
              <Box>
                <Text size="xs" c="dimmed">
                  {pack.unavailableCount} item(s) in this pack are no longer listed.
                </Text>
              </Box>
            )}
          </Stack>
        </Grid.Col>
      </Grid>
    </Modal>
  );
};

export const PackPurchaseCompleteModal = ({ names }: { names: string[] }) => {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} size="md" withCloseButton={false} radius="lg">
      <Stack gap="lg" px="md">
        <Group justify="space-between">
          <Text className="text-black dark:text-white">Your pack is unpacked!</Text>
          <CloseButton onClick={dialog.onClose} />
        </Group>
        <Stack gap={4}>
          {names.map((name) => (
            <Text key={name} size="sm">
              {name}
            </Text>
          ))}
        </Stack>
        <Button radius="xl" mx="auto" onClick={dialog.onClose}>
          Done
        </Button>
      </Stack>
    </Modal>
  );
};
