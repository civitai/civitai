import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Button, Popover, Text } from '@mantine/core';
import { PaymentMethodConfig, isBrowserSupported } from './zkp2p-config';
import { trackZkp2pEvent, generateZkp2pSessionId } from '~/utils/zkp2p-tracking';

type Props = {
  method: string;
  config: PaymentMethodConfig;
  amount: number;
  buzzAmount: number;
  disabled?: boolean;
  onRedirect?: () => void;
};

export function BuzzZkp2pButton({
  method,
  config,
  amount,
  buzzAmount,
  disabled = false,
  onRedirect,
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const isSupported = useMemo(() => isBrowserSupported(), []);
  const sessionIdRef = useRef<string>('');

  const handleClick = async () => {
    setLoading(true);
    // Generate session ID
    sessionIdRef.current = generateZkp2pSessionId();

    // Track the attempt
    await trackZkp2pEvent({
      sessionId: sessionIdRef.current,
      eventType: 'attempt',
      paymentMethod: method as any,
      usdAmount: amount,
      buzzAmount: buzzAmount,
    });

    const params = new URLSearchParams({
      paymentMethod: method,
      amount: amount.toString(),
      buzzAmount: buzzAmount.toString(),
      sessionId: sessionIdRef.current,
      explain: 'true',
    });

    router.push(`/purchase/zkp2p?${params.toString()}`);
    onRedirect?.();
  };

  const Icon = config.icon;

  if (!isSupported) {
    return (
      <Popover position="top" withArrow>
        <Popover.Target>
          <Button
            disabled
            size="md"
            radius="md"
            variant="light"
            color="yellow"
            fw={500}
            leftSection={<Icon size={16} />}
          >
            {config.label}
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <Text size="sm">
            This payment method requires Desktop Chrome, Edge, or Brave browser. Mobile browsers and
            Safari are not supported yet.
          </Text>
        </Popover.Dropdown>
      </Popover>
    );
  }

  return (
    <Button
      disabled={disabled || loading}
      loading={loading}
      onClick={handleClick}
      size="md"
      radius="md"
      variant="light"
      color="yellow"
      fw={500}
      leftSection={<Icon size={16} />}
    >
      {config.label}
    </Button>
  );
}
