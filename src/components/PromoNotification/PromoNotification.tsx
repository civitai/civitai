import {
  CloseButton,
  Group,
  Text,
  CopyButton,
  ActionIcon,
  Paper,
  Badge
} from '@mantine/core';
import { IconClock, IconCopy, IconCheck } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { Countdown } from '~/components/Countdown/Countdown';
import type { VendorPromo } from '~/utils/gift-cards/vendors/types';
import {
  isPromoActive,
  isPromoDismissed,
  dismissPromo,
} from '~/utils/gift-cards/promo-utils';

interface PromoNotificationProps {
  vendorId: string;
  vendorName: string;
  promo: VendorPromo | undefined;
}

export function PromoNotification({ vendorId, vendorName, promo }: PromoNotificationProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!promo) {
      setIsVisible(false);
      return;
    }

    const active = isPromoActive(promo);
    const dismissed = isPromoDismissed(vendorId, promo.code);
    setIsVisible(active && !dismissed);

    if (!active) {
      return;
    }

    const checkExpiry = setInterval(() => {
      if (isPromoActive(promo)) return;
      setIsVisible(false);
      clearInterval(checkExpiry);
    }, 60000); // Check every minute if promo has expired

    return () => clearInterval(checkExpiry);
  }, [promo, vendorId]);

  if (!promo || !isVisible) {
    return null;
  }

  const handleDismiss = () => {
    dismissPromo(vendorId, promo);
    setIsVisible(false);
  };

  const message = promo.message || `${promo.discount} on ${vendorName} purchases`;

  return (
    <Paper
      shadow="sm"
      radius="md"
      px="md"
      py="xs"
      withBorder
      className='flex items-center justify-between'
    >
      <div className="flex flex-wrap flex-1 items-center gap-2">
          <Badge
            size="xs"
            color="green"
            variant="dot"
            className="bg-transparent border-none p-0"
          />
          <Text size="sm" fw={500}>
            {message}
          </Text>

          <CopyButton value={promo.code} timeout={2000}>
            {({ copied, copy }) => (
              <Badge
                size="lg"
                variant={copied ? 'light' : 'default'}
                color={copied ? 'green' : 'gray'}
                leftSection={
                  <ActionIcon
                    variant="transparent"
                    size="xs"
                    color={copied ? 'green' : 'gray'}
                  >
                    {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                  </ActionIcon>
                }
                onClick={copy}
                className="cursor-pointer transition-all duration-200"
                styles={{
                  label: { fontWeight: 700, fontSize: '0.875rem' }
                }}
              >
                {promo.code}
              </Badge>
            )}
          </CopyButton>

          <Badge
            variant="light"
            color="orange"
            leftSection={<IconClock size={14} />}
            className="bg-transparent font-medium"
          >
            <Countdown endTime={promo.endDate} refreshIntervalMs={60000} format="short" />
          </Badge>
        </div>

        <CloseButton
          size="sm"
          onClick={handleDismiss}
          aria-label="Dismiss"
          variant="subtle"
        />
    </Paper>
  );
}
