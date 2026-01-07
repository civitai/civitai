import { Button, Group, Stack, Text, TextInput, ThemeIcon, Modal } from '@mantine/core';
import { IconTicket } from '@tabler/icons-react';
import clsx from 'clsx';
import React, { useState } from 'react';
import dynamic from 'next/dynamic';
import { trpc } from '~/utils/trpc';
import { numberWithCommas } from '~/utils/number-helpers';
import classes from './RedeemCodeCard.module.scss';
import { RedeemableCodeType } from '~/shared/utils/prisma/enums';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { showErrorNotification, showWarningNotification } from '~/utils/notifications';
import { formatDate } from '~/utils/date-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { GiftNoticeAlert } from './GiftNoticeAlert';
import type { GiftNotice } from '~/server/schema/redeemableCode.schema';
import { GIFT_CARD_DISCLAIMER } from '~/utils/gift-cards/constants';

const SuccessAnimation = dynamic(
  () => import('~/components/Animations/SuccessAnimation').then((mod) => mod.SuccessAnimation),
  { ssr: false }
);

interface RedeemCodeCardProps {
  /**
   * Whether to show the icon section
   */
  showIcon?: boolean;
  /**
   * Custom text for the description
   */
  description?: string;
  /**
   * Size variant for the component
   */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Initial code value (for URL parameters)
   */
  initialCode?: string;
  /**
   * Custom title text
   */
  title?: string;
  /**
   * Custom placeholder text
   */
  placeholder?: string;
  /**
   * Custom class name for styling
   */
  className?: string;
}

type RedeemStatus = 'idle' | 'loading' | 'success';

interface RedeemState {
  status: RedeemStatus;
  code: string;
  successMessage?: string;
  showSuccessModal?: boolean;
  redeemedAt?: Date;
  giftNotices?: GiftNotice[];
}

export function RedeemCodeCard({
  showIcon = true,
  description = 'Enter your unique code to instantly receive rewards',
  size = 'lg',
  initialCode = '',
  title = 'Redeem Your Code',
  placeholder = 'BUZZ-CODE-HERE',
  className,
}: RedeemCodeCardProps) {
  const currentUser = useCurrentUser();
  const [redeemState, setRedeemState] = useState<RedeemState>({
    status: 'idle',
    code: initialCode,
  });
  const queryUtils = trpc.useUtils();

  const redeemCodeMutation = trpc.redeemableCode.consume.useMutation({
    onSuccess: async (consumedCode) => {
      // Generate success message based on code type
      let message = 'Code redeemed successfully';

      if (!consumedCode) {
        showErrorNotification({
          title: 'Error redeeming code',
          error: new Error('Code not found or invalid.'),
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

      // Set success state with message and show modal
      setRedeemState({
        status: 'success',
        code: '',
        successMessage: message,
        showSuccessModal: true,
        redeemedAt: consumedCode.redeemedAt ?? new Date(),
        giftNotices: consumedCode.giftNotices || [],
      });

      await Promise.all([
        currentUser?.refresh(),
        queryUtils.buzz.getAccountTransactions.invalidate(),
        queryUtils.buzz.getBuzzAccount.invalidate(),
        queryUtils.subscriptions.getUserSubscription.invalidate(),
      ]);

      // Only auto-close if there are no gift notices
      const hasGiftNotices = (consumedCode.giftNotices || []).length > 0;
      if (!hasGiftNotices) {
        setTimeout(
          () => setRedeemState({ status: 'idle', code: '', showSuccessModal: false }),
          5000
        );
      }
    },
    onError: (error) => {
      setRedeemState((prev) => ({ ...prev, status: 'idle' }));
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
        autoClose: false,
      });
    },
  });

  const handleRedeem = async () => {
    if (redeemState.status !== 'idle') return;

    if (!redeemState.code.trim()) {
      showWarningNotification({
        title: 'Missing Code',
        message: 'Please enter a code to redeem',
      });

      return;
    }

    setRedeemState({ status: 'loading', code: redeemState.code });
    redeemCodeMutation.mutate({ code: redeemState.code.trim() });
  };

  const handleCodeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    // Remove spaces and convert to uppercase automatically
    const cleanedCode = event.currentTarget.value.replace(/\s+/g, '').toUpperCase();
    setRedeemState((prev) => ({ ...prev, code: cleanedCode }));
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && redeemState.status === 'idle') {
      handleRedeem();
    }
  };

  return (
    <div className={clsx(classes.redeemSection, className)}>
      <div className={classes.contentSection}>
        <Stack gap="sm">
          <Group align="center">
            {/* Icon Section */}
            {showIcon && (
              <div className={classes.iconSection}>
                <ThemeIcon
                  size="xl"
                  variant="gradient"
                  gradient={{ from: 'yellow.4', to: 'orange.5' }}
                  radius="md"
                >
                  <IconTicket size={28} />
                </ThemeIcon>
              </div>
            )}
            <div>
              <Text size="xl" fw={700} className={classes.redeemTitle}>
                {title}
              </Text>
              <Text size="sm" c="dimmed" className={classes.redeemDescription}>
                {description}
              </Text>
            </div>
          </Group>

          <Group gap="sm" wrap="nowrap" className={classes.inputGroup}>
            <TextInput
              placeholder={placeholder}
              value={redeemState.code}
              onChange={handleCodeChange}
              onKeyDown={handleKeyDown}
              size={size}
              disabled={redeemState.status === 'loading'}
              className={classes.codeInput}
              style={{ flex: 1 }}
              variant="filled"
              radius="md"
            />

            <Button
              onClick={handleRedeem}
              loading={redeemState.status === 'loading'}
              size={size}
              variant="gradient"
              gradient={{ from: 'yellow.4', to: 'orange.5' }}
              className={classes.redeemButton}
              px="xl"
              radius="md"
            >
              Redeem
            </Button>
          </Group>

          <Text size="xs" c="dimmed" className={classes.helpText}>
            Case-insensitive • Spaces auto-removed • Instant processing
          </Text>

          <Text size="xs" c="dimmed" ta="center">
            {GIFT_CARD_DISCLAIMER.redemption}
          </Text>
        </Stack>
      </div>

      <Modal
        opened={!!redeemState.showSuccessModal}
        onClose={() => setRedeemState({ status: 'idle', code: '', showSuccessModal: false })}
        withCloseButton={!!(redeemState.giftNotices && redeemState.giftNotices.length > 0)}
        closeOnClickOutside={false}
        closeOnEscape={false}
        withOverlay={false}
        lockScroll={false}
        size="auto"
        radius="lg"
        centered
      >
        <div className="flex flex-col gap-2">
          <SuccessAnimation
            gap={8}
            lottieProps={{ style: { width: 120, margin: 0 } }}
            align="center"
            justify="center"
          >
            <Stack gap="md">
              <Stack gap="xs">
                <Text size="xl" fw={500} ta="center">
                  {redeemState.successMessage || 'Code redeemed successfully'}
                </Text>
                {redeemState.redeemedAt && (
                  <Text size="sm" c="dimmed" ta="center">
                    Redeemed on {formatDate(redeemState.redeemedAt)}
                  </Text>
                )}
              </Stack>

              {redeemState.giftNotices && redeemState.giftNotices.length > 0 && (
                <Stack gap="md">
                  {redeemState.giftNotices.map((notice, index) => (
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
        </div>
      </Modal>
    </div>
  );
}
