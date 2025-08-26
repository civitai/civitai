import { useMemo } from 'react';
import { useRouter } from 'next/router';
import { Button, Popover, Text, ButtonProps } from '@mantine/core';
import { PaymentMethodConfig, isBrowserSupported } from './zkp2p-config';

type Props = ButtonProps & {
  method: string;
  config: PaymentMethodConfig;
  amount: number;
  buzzAmount: number;
};

export function BuzzZkp2pButton({
  method,
  config,
  amount,
  buzzAmount,
  ...buttonProps
}: Props) {
  const router = useRouter();
  const isSupported = useMemo(() => isBrowserSupported(), []);

  const handleClick = () => {
    const params = new URLSearchParams({
      paymentMethod: method,
      amount: amount.toString(),
      buzzAmount: buzzAmount.toString(),
    });
    
    router.push(`/purchase/zkp2p?${params.toString()}`);
  };

  const Icon = config.icon;

  if (!isSupported) {
    return (
      <Popover position="top" withArrow>
        <Popover.Target>
          <Button
            {...buttonProps}
            disabled
            leftSection={<Icon size={20} />}
          >
            {config.label}
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <Text size="sm">
            This payment method requires Desktop Chrome, Edge, or Brave browser.
            Mobile browsers and Safari are not supported yet.
          </Text>
        </Popover.Dropdown>
      </Popover>
    );
  }

  return (
    <Button
      {...buttonProps}
      onClick={handleClick}
      leftSection={<Icon size={20} />}
    >
      {config.label}
    </Button>
  );
}