import { Card, Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconBolt, IconSparkles } from '@tabler/icons-react';
import { BUZZ_FEATURE_LIST } from '~/server/common/constants';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import classes from './BuzzFeatures.module.scss';

interface BuzzFeaturesProps {
  /** Custom title for the features section */
  title?: string;
  subtitle?: string;
  /** Whether to show as a card or just the list */
  variant?: 'card' | 'list';
  /** Custom features list - defaults to BUZZ_FEATURE_LIST */
  features?: string[];
  /** Whether to show header with icon */
  showHeader?: boolean;
  /** Compact mode for smaller spaces */
  compact?: boolean;
  /** Buzz type for theming */
  buzzType?: BuzzSpendType;
}

export const BuzzFeatures = ({
  title = 'Buzz Benefits',
  subtitle = '',
  variant = 'card',
  features = BUZZ_FEATURE_LIST,
  showHeader = true,
  compact = false,
  buzzType,
}: BuzzFeaturesProps) => {
  const buzzConfig = useBuzzCurrencyConfig(buzzType);

  const content = (
    <Stack gap={compact ? 'xs' : 'sm'}>
      {showHeader && (
        <Group gap="sm" className={classes.header}>
          <ThemeIcon
            size={compact ? 32 : 38}
            radius="lg"
            className={classes.headerIcon}
            color={buzzConfig.color}
          >
            <IconSparkles size={compact ? 18 : 22} stroke={2.5} />
          </ThemeIcon>
          <div>
            <Title order={compact ? 4 : 3} className={classes.title} size={compact ? 'md' : 'lg'}>
              {title}
            </Title>
            {subtitle && (
              <Text size={compact ? 'xs' : 'sm'} c="dimmed" className={classes.subtitle}>
                Everything you can do with Buzz
              </Text>
            )}
          </div>
        </Group>
      )}

      <Stack gap={compact ? 'xs' : 'sm'} className={classes.featureList}>
        {features.map((feature) => (
          <Group
            key={feature}
            wrap="nowrap"
            gap={compact ? 'sm' : 'md'}
            align="center"
            className={classes.featureItem}
          >
            <ThemeIcon
              size={compact ? 22 : 26}
              radius="md"
              className={classes.featureIcon}
              variant="filled"
              color={buzzConfig.color}
            >
              <IconBolt size={compact ? 14 : 16} stroke={2.5} fill="currentColor" />
            </ThemeIcon>
            <Text size={compact ? 'sm' : 'md'} className={classes.featureText} fw={500} lh={1.4}>
              {feature}
            </Text>
          </Group>
        ))}
      </Stack>
    </Stack>
  );

  if (variant === 'list') {
    return (
      <div
        className={classes.listWrapper}
        style={{
          // @ts-ignore
          '--buzz-color': buzzConfig.colorRgb,
          '--buzz-gradient': buzzConfig.css?.gradient,
        }}
      >
        {content}
      </div>
    );
  }

  return (
    <Card
      className={classes.featuresCard}
      padding={compact ? 'md' : 'lg'}
      radius="md"
      style={{
        // @ts-ignore
        '--buzz-color': buzzConfig.colorRgb,
        '--buzz-gradient': buzzConfig.css?.gradient,
      }}
    >
      {content}
    </Card>
  );
};

// Legacy component for backward compatibility
export const BuzzFeaturesList = ({
  compact = false,
  ...props
}: {
  compact?: boolean;
} & Omit<BuzzFeaturesProps, 'variant'>) => (
  <BuzzFeatures variant="list" compact={compact} showHeader={false} {...props} />
);
