import { CloseButton, Group, Text, CopyButton, ActionIcon, Paper, Badge } from '@mantine/core';
import { IconClock, IconCopy, IconCheck } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { Countdown } from '~/components/Countdown/Countdown';
import type { VendorPromo } from '~/utils/gift-cards/vendors/types';
import { isPromoActive, isPromoDismissed, dismissPromo } from '~/utils/gift-cards/promo-utils';
import classes from './PromoNotification.module.scss';

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
    <CopyButton value={promo.code} timeout={2000}>
      {({ copied, copy }) => (
        <Paper
          shadow="sm"
          radius="md"
          px="md"
          py="xs"
          withBorder
          onClick={copy}
          className={`${classes.promoNotification} flex cursor-pointer items-center justify-between`}
        >
          <div
            className={`${classes.promoContent} flex flex-1 flex-wrap items-center justify-between gap-2`}
          >
            {/* Description */}
            <Text size="sm" fw={500} className={classes.promoText}>
              {message}
            </Text>

            {/* Code & Time */}
            <div className="flex items-center gap-3">
              <Badge
                size="lg"
                variant="transparent"
                leftSection={
                  <ActionIcon variant="transparent" size="xs" className={classes.promoIcon}>
                    {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                  </ActionIcon>
                }
                className={`${classes.promoCodeBadge} transition-all duration-200`}
              >
                {promo.code}
              </Badge>

              <Badge
                variant="transparent"
                leftSection={<IconClock size={14} className={classes.promoIcon} />}
                className={classes.promoCountdownBadge}
              >
                <Countdown endTime={promo.endDate} refreshIntervalMs={60000} format="short" />
              </Badge>
              <CloseButton
                size="sm"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  handleDismiss();
                }}
                aria-label="Dismiss"
                variant="transparent"
                className={classes.promoCloseButton}
              />
            </div>
          </div>
        </Paper>
      )}
    </CopyButton>
  );
}
