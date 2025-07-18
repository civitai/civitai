import { Button, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import React, { useState } from 'react';
import { showNotification } from '@mantine/notifications';
import { trpc } from '~/utils/trpc';

interface RedeemCodeCardProps {
  /**
   * Whether to show the credit card upsell text
   */
  showUpsell?: boolean;
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
   * Whether to show the header title
   */
  showHeader?: boolean;
}

export function RedeemCodeCard({
  showUpsell = true,
  description = 'Got a Buzz code? Redeem it instantly for rewards and exclusive perks.',
  size = 'md',
  initialCode = '',
  showHeader = true,
}: RedeemCodeCardProps) {
  const [code, setCode] = useState(initialCode);
  const [isLoading, setIsLoading] = useState(false);

  const redeemCodeMutation = trpc.redeemableCode.consume.useMutation({
    onSuccess: (result: { unitValue: number; type: string }) => {
      setCode('');
      setIsLoading(false);
      showNotification({
        title: 'Code redeemed successfully!',
        message: `You received ${result.unitValue} Buzz!`,
        color: 'green',
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

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !isLoading) {
      handleRedeem();
    }
  };
  const sizeClasses = {
    sm: {
      padding: 'md',
      gap: 'sm',
      titleSize: 'text-xl',
      textSize: 'sm',
      inputSize: 'sm',
      buttonSize: 'sm',
    },
    md: {
      padding: 'xl',
      gap: 'md',
      titleSize: 'text-2xl',
      textSize: 'md',
      inputSize: 'md',
      buttonSize: 'md',
    },
    lg: {
      padding: '2.5rem',
      gap: 'lg',
      titleSize: 'text-3xl',
      textSize: 'lg',
      inputSize: 'lg',
      buttonSize: 'lg',
    },
  };

  const classes = sizeClasses[size];

  return (
    <Paper
      className="relative overflow-hidden rounded-xl border-l-4 border-l-yellow-500 bg-blue-50 shadow-lg dark:bg-dark-6"
      p={0}
      withBorder
    >
      <Stack p={classes.padding} align="center" justify="center" gap={classes.gap}>
        {showHeader && (
          <div className="space-y-2 text-center">
            <Title
              order={2}
              className={`${classes.titleSize} font-bold text-blue-900 dark:text-blue-100`}
            >
              Redeem Buzz Code
            </Title>
            <Text size={classes.textSize} className="mx-auto max-w-sm font-medium" c="dimmed">
              {description}
            </Text>
          </div>
        )}
        {!showHeader && description && (
          <div className="text-center">
            <Text size={classes.textSize} className="mx-auto max-w-sm font-medium" c="dimmed">
              {description}
            </Text>
          </div>
        )}

        <div className="w-full max-w-sm space-y-3">
          <TextInput
            placeholder="Enter your Buzz code"
            value={code}
            onChange={(event) => setCode(event.currentTarget.value)}
            onKeyPress={handleKeyPress}
            size={classes.inputSize}
            disabled={isLoading}
            className="text-center"
            styles={{
              input: {
                textAlign: 'center',
                fontWeight: 'bold',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              },
            }}
          />
          <Button
            onClick={handleRedeem}
            loading={isLoading}
            size={classes.buttonSize}
            fullWidth
            variant="filled"
            color="yellow"
            maw={250}
            className="mx-auto"
          >
            {isLoading ? 'Redeeming...' : 'Redeem Code'}
          </Button>
        </div>

        {showUpsell && (
          <Text size="sm" className="font-medium" c="dimmed">
            Don&rsquo;t have one yet?{' '}
            <Text component="a" href="#" className="font-semibold underline" c="blue">
              Purchase now
            </Text>
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
