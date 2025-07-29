import { Anchor, Card, Group, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import React from 'react';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import type { BuzzSpendType } from '~/server/schema/buzz.schema';
import classes from './PromoBanner.module.scss';

export interface PromoBannerProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  buyNowHref: string;
  buyNowText?: string;
  learnMoreHref?: string;
  learnMoreText?: string;
  buzzType?: BuzzSpendType;
}

export const PromoBanner = ({
  icon,
  title,
  subtitle,
  buyNowHref,
  buyNowText = 'Buy Now',
  learnMoreHref,
  learnMoreText = 'Learn More',
  buzzType,
}: PromoBannerProps) => {
  const buzzConfig = useBuzzCurrencyConfig(buzzType);

  return (
    <Card
      className={classes.promoBanner}
      padding="md"
      radius="md"
      style={{
        // @ts-ignore
        '--buzz-color': buzzConfig.colorRgb,
        '--buzz-gradient': buzzConfig.css?.gradient,
      }}
    >
      <div className={classes.promoBackground}>
        <div className={classes.promoLayout}>
          <Group gap="md" wrap="nowrap" className={classes.promoContent}>
            <div className={classes.iconWrapper}>{icon}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="lg" fw={700} className={classes.promoTitle}>
                {title}
              </Text>
              <Text size="sm" className={classes.promoSubtitle}>
                {subtitle}
              </Text>
            </div>
          </Group>

          <Group gap="xs" wrap="nowrap" className={classes.promoButtons}>
            <Anchor
              href={buyNowHref}
              target="_blank"
              rel="noopener noreferrer"
              className={classes.promoCta}
            >
              <Group gap="xs">
                <Text size="sm" fw={600}>
                  {buyNowText}
                </Text>
                <IconExternalLink size={14} />
              </Group>
            </Anchor>
            {learnMoreHref && (
              <Anchor
                href={learnMoreHref}
                target="_blank"
                rel="noopener noreferrer"
                className={classes.promoLearnMore}
              >
                <Text size="sm" fw={500}>
                  {learnMoreText}
                </Text>
              </Anchor>
            )}
          </Group>
        </div>
      </div>
    </Card>
  );
};
