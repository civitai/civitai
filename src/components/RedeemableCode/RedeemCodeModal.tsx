import { Modal, Stack, Group, Button, Text } from '@mantine/core';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Form, InputText, useForm } from '~/libs/form';
import type { ConsumeRedeemableCodeInput } from '~/server/schema/redeemableCode.schema';
import { consumeRedeemableCodeSchema } from '~/server/schema/redeemableCode.schema';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { RedeemableCodeType } from '~/shared/utils/prisma/enums';
import classes from './RedeemCodeModal.module.scss';
import { GiftNoticeAlert } from '~/components/RedeemCode/GiftNoticeAlert';
import type { GiftNotice } from '~/server/schema/redeemableCode.schema';
import { GIFT_CARD_DISCLAIMER } from '~/utils/gift-cards/constants';

const SuccessAnimation = dynamic(
  () => import('~/components/Animations/SuccessAnimation').then((mod) => mod.SuccessAnimation),
  { ssr: false }
);

export function RedeemCodeModal({ onSubmit, code }: { onSubmit?: VoidFunction; code?: string }) {
  const dialog = useDialogContext();
  const queryUtils = trpc.useUtils();

  const [playAnimation, setPlayAnimation] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [giftNotices, setGiftNotices] = useState<GiftNotice[]>([]);

  const form = useForm({ schema: consumeRedeemableCodeSchema, defaultValues: { code } });

  const redeemCodeMutation = trpc.redeemableCode.consume.useMutation({
    onSuccess: async (consumedCode) => {
      // Generate success message based on code type
      let message = 'Code redeemed successfully';

      if (!consumedCode) {
        showErrorNotification({
          title: 'Error redeeming code',
          error: new Error('Code not found or invalid'),
        });
        return;
      }

      if (consumedCode.type === RedeemableCodeType.Buzz) {
        const buzzAmount = numberWithCommas(consumedCode.unitValue);
        message = `${buzzAmount} Buzz has been added to your account!`;
      } else if (consumedCode.type === RedeemableCodeType.Membership && consumedCode.price) {
        const metadata = consumedCode.price.product.metadata as SubscriptionProductMetadata;
        const timeValue = consumedCode.unitValue;
        const interval = consumedCode.price.interval ?? '';
        // Calculate the time period
        const timeDescription = `${timeValue} ${interval}${timeValue > 1 ? 's' : ''}`;
        const tierName = metadata.tier
          ? metadata.tier.charAt(0).toUpperCase() + metadata.tier.slice(1)
          : 'Premium';
        message = `${timeDescription} of ${tierName} tier membership has been added to your account!`;
      }

      setSuccessMessage(message);
      setGiftNotices(consumedCode.giftNotices || []);
      setPlayAnimation(true);
      onSubmit?.();

      await Promise.all([
        queryUtils.buzz.getAccountTransactions.invalidate(),
        queryUtils.buzz.getBuzzAccount.invalidate(),
      ]);
    },
    onError: (error) => {
      let errorMessage: string;
      try {
        // Try to parse as JSON first
        const parsedError = JSON.parse(error.message);
        errorMessage = parsedError[0]?.message || parsedError.message || error.message;
      } catch {
        // If parsing fails, use the original message
        errorMessage = error.message;
      }

      showErrorNotification({
        title: 'Failed to redeem code',
        error: new Error(
          errorMessage ||
            'There was an error processing your code. Please check the code and try again.'
        ),
      });
    },
  });
  const handleSubmit = (data: ConsumeRedeemableCodeInput) => {
    redeemCodeMutation.mutate(data);
  };

  return (
    <Modal
      {...dialog}
      title="Redeem a Code"
      withCloseButton={playAnimation && giftNotices.length > 0}
    >
      {playAnimation ? (
        <Stack>
          <SuccessAnimation
            gap={8}
            lottieProps={{ style: { width: 120, margin: 0 } }}
            align="center"
            justify="center"
          >
            <Stack gap="md">
              <Text size="xl" fw={500} align="center">
                {successMessage || 'Code redeemed successfully'}
              </Text>

              {giftNotices.length > 0 && (
                <Stack gap="md">
                  {giftNotices.map((notice, index) => (
                    <GiftNoticeAlert
                      key={index}
                      title={notice.title}
                      message={notice.message}
                      linkUrl={notice.linkUrl}
                      linkText={notice.linkText}
                    />
                  ))}
                </Stack>
              )}
            </Stack>
          </SuccessAnimation>
          {giftNotices.length === 0 && (
            <Group justify="flex-end">
              <Button className={classes.submitButton} onClick={dialog.onClose}>
                Close
              </Button>
            </Group>
          )}
        </Stack>
      ) : (
        <Form form={form} onSubmit={handleSubmit}>
          <Stack>
            <InputText
              name="code"
              label="Code"
              placeholder="AB-AB12-34CD"
              maxLength={12}
              autoFocus
            />
            <Text size="xs" c="dimmed">
              {GIFT_CARD_DISCLAIMER.redemption}
            </Text>
            <Group justify="flex-end">
              <Button
                className={classes.cancelButton}
                variant="light"
                color="gray"
                onClick={dialog.onClose}
              >
                Cancel
              </Button>
              <Button
                className={classes.submitButton}
                type="submit"
                loading={redeemCodeMutation.isLoading}
              >
                Redeem
              </Button>
            </Group>
          </Stack>
        </Form>
      )}
    </Modal>
  );
}
