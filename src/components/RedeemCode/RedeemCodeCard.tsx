import { Button, Group, Stack, Text, TextInput, ThemeIcon, Loader } from '@mantine/core';
import { IconTicket } from '@tabler/icons-react';
import React, { useState } from 'react';
import { showNotification } from '@mantine/notifications';
import { trpc } from '~/utils/trpc';
import { numberWithCommas } from '~/utils/number-helpers';
import classes from './RedeemCodeCard.module.scss';
import { RedeemableCodeType } from '~/shared/utils/prisma/enums';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';

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

export function RedeemCodeCard({
  showIcon = true,
  description = 'Enter your unique code to instantly receive rewards',
  size = 'lg',
  initialCode = '',
  title = 'Redeem Your Code',
  placeholder = 'BUZZ-CODE-HERE',
  className,
}: RedeemCodeCardProps) {
  const [code, setCode] = useState(initialCode);
  const [isLoading, setIsLoading] = useState(false);
  const queryUtils = trpc.useUtils();

  const redeemCodeMutation = trpc.redeemableCode.consume.useMutation({
    onSuccess: async (consumedCode) => {
      setCode('');
      setIsLoading(false);
      // Generate success message based on code type
      let message = 'Code redeemed successfully';

      if (!consumedCode) {
        showNotification({
          title: 'Error redeeming code',
          message: 'Code not found or invalid.',
          color: 'red',
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

      showNotification({
        title: 'Success',
        message,
        color: 'green',
      });

      await queryUtils.buzz.getAccountTransactions.invalidate();
    },
    onError: (data) => {
      setIsLoading(false);
      showNotification({
        title: 'Failed to redeem code',
        message: 'There was an error processing your code. Please check the code and try again.',
        color: 'red',
      });
    },
  });

  const handleRedeem = async () => {
    if (!code.trim()) {
      showNotification({
        title: 'Missing Code',
        message: 'Please enter a code to redeem',
        color: 'yellow',
      });

      return;
    }

    setIsLoading(true);
    redeemCodeMutation.mutate({ code: code.trim() });
  };

  const handleCodeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    // Remove spaces and convert to uppercase automatically
    const cleanedCode = event.currentTarget.value.replace(/\s+/g, '').toUpperCase();
    setCode(cleanedCode);
  };

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !isLoading) {
      handleRedeem();
    }
  };

  return (
    <div className={`${classes.redeemSection} ${className || ''}`}>
      {/* Content Section */}
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
              value={code}
              onChange={handleCodeChange}
              onKeyPress={handleKeyPress}
              size={size}
              disabled={isLoading}
              className={classes.codeInput}
              style={{ flex: 1 }}
              variant="filled"
              radius="md"
            />

            <Button
              onClick={handleRedeem}
              loading={isLoading}
              size={size}
              variant="gradient"
              gradient={{ from: 'yellow.4', to: 'orange.5' }}
              className={classes.redeemButton}
              px="xl"
              radius="md"
            >
              {isLoading ? <Loader size="sm" color="white" /> : 'Redeem'}
            </Button>
          </Group>

          <Text size="xs" c="dimmed" className={classes.helpText}>
            Case-insensitive • Spaces auto-removed • Instant processing
          </Text>
        </Stack>
      </div>
    </div>
  );
}
