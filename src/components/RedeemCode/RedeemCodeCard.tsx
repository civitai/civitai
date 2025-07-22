import { Button, Group, Stack, Text, TextInput, ThemeIcon, Loader } from '@mantine/core';
import { IconTicket } from '@tabler/icons-react';
import React, { useState } from 'react';
import { showNotification } from '@mantine/notifications';
import { trpc } from '~/utils/trpc';
import { numberWithCommas } from '~/utils/number-helpers';
import classes from './RedeemCodeCard.module.scss';

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

  const redeemCodeMutation = trpc.redeemableCode.consume.useMutation({
    onSuccess: (result: { unitValue: number; type: string }) => {
      setCode('');
      setIsLoading(false);
      showNotification({
        title: '🎉 Code redeemed successfully!',
        message: `You received ${numberWithCommas(result.unitValue)} Buzz!`,
        color: 'green',
        autoClose: 5000,
      });
    },
    onError: (error: { message: string }) => {
      setIsLoading(false);
      showNotification({
        title: 'Failed to redeem code',
        message: error.message,
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
