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
    const dismissed = isPromoDismissed(vendorId, promo);
    setIsVisible(active && !dismissed);

    if (!active) {
      return;
    }

    const checkExpiry = window.setInterval(() => {
      if (isPromoActive(promo)) return;
      setIsVisible(false);
      window.clearInterval(checkExpiry);
    }, 60000); // Check every minute if promo has expired

    return () => window.clearInterval(checkExpiry);
  }, [promo, vendorId]);

  if (!promo || !isVisible) {
    return null;
  }

  const handleDismiss = () => {
    dismissPromo(vendorId, promo);
    setIsVisible(false);
  };

  const message = promo.message || (promo.discount ? `${promo.discount} on ${vendorName} purchases` : '');

  const isCompact = !promo.code;

  const content = (
    <Paper
      shadow="sm"
      radius="md"
      px="md"
      py="xs"
      withBorder
      className={`${classes.promoNotification} flex items-center ${promo.code ? 'cursor-pointer justify-between' : ''}`}
      style={isCompact ? { width: 'fit-content' } : undefined}
    >
      <div
        className={`${classes.promoContent} flex flex-1 items-center justify-between gap-2 ${isCompact ? 'flex-nowrap' : 'flex-wrap'}`}
      >
        {/* Description */}
        <Text size="sm" fw={500} className={classes.promoText}>
          {message}
        </Text>

        {/* Code & Time (only show if there's a promo code) */}
        <div className="flex items-center gap-3">
          {promo.code && (
            <>
              <Badge
                size="lg"
                variant="transparent"
                leftSection={
                  <ActionIcon variant="transparent" size="xs" className={classes.promoIcon}>
                    <IconCopy size={12} />
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
            </>
          )}
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
  );

  // Only wrap in CopyButton if there's a code to copy
  if (promo.code) {
    return (
      <CopyButton value={promo.code} timeout={2000}>
        {({ copied, copy }) => (
          <div onClick={copy}>
            {content}
          </div>
        )}
      </CopyButton>
    );
  }

  return content;
}
