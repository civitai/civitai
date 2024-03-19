import { useTheme } from '@emotion/react';
import { Button, Center, Group, Loader, Modal, Paper, Radio, Stack } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { useQueryVault } from '~/components/Vault/vault.util';

const downgradeReasons = ['Too expensive', 'I don’t need all the benefits', 'Others'];

export const DowngradeFeedbackModal = ({
  priceId,
  upcomingVaultSizeKb,
  fromTier,
  toTier,
}: {
  priceId: string;
  upcomingVaultSizeKb?: number;
  fromTier?: string;
  toTier?: string;
}) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const [downgradeReason, setDowngradeReason] = useState(downgradeReasons[0]);
  const { vault, isLoading } = useQueryVault();
  const { trackAction } = useTrackEvent();

  const storageExceededAfterChange =
    upcomingVaultSizeKb && vault && upcomingVaultSizeKb < vault.usedStorageKb;

  return (
    <Modal {...dialog} size="md" title="Tell us why" radius="md">
      {isLoading ? (
        <Center>
          <Loader />
        </Center>
      ) : (
        <Stack>
          <Radio.Group
            value={downgradeReason}
            orientation="vertical"
            label="We love to hear the reason for your downgrade. It will help us improve our service."
            onChange={(value) => {
              setDowngradeReason(value);
            }}
            withAsterisk
            spacing="xs"
          >
            {downgradeReasons.map((item) => (
              <Paper key={item} withBorder radius="md" p="md">
                <Radio value={item} label={item} />
              </Paper>
            ))}
          </Radio.Group>
          <Group grow>
            <SubscribeButton priceId={priceId}>
              {({ onClick, ...props }) => (
                <Button
                  color="gray"
                  onClick={() => {
                    trackAction({
                      type: 'Membership_Downgrade',
                      details: {
                        reason: downgradeReason,
                        from: fromTier,
                        to: toTier,
                      },
                    }).catch(() => undefined);

                    if (storageExceededAfterChange) {
                      // TODO
                    } else {
                      onClick();
                    }
                  }}
                  radius="xl"
                  {...props}
                >
                  Downgrade
                </Button>
              )}
            </SubscribeButton>
            <Button color="blue" onClick={handleClose} radius="xl">
              Don&rsquo;t change plan
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
};
