import { Paper, Stack, Title, Text, Grid } from '@mantine/core';
import { IconCoin, IconShoppingCart, IconCreditCard } from '@tabler/icons-react';
import React from 'react';
import classes from '~/components/Buzz/buzz.module.scss';
import styles from './GetPaid.module.scss';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';

interface InstructionalCardProps {
  step: number;
  title: string;
  description: string;
  icon: React.ReactNode;
}

function InstructionalCard({ step, title, description, icon }: InstructionalCardProps) {
  const redBuzzConfig = useBuzzCurrencyConfig('red');

  // Set CSS variable for dynamic color
  React.useEffect(() => {
    if (redBuzzConfig.color) {
      document.documentElement.style.setProperty('--red-buzz-color', redBuzzConfig.color);
    }
  }, [redBuzzConfig.color]);

  return (
    <Paper withBorder p="md" radius="md" className={styles.instructionalCard}>
      {/* Step number indicator */}
      <div className={styles.stepIndicator}>{step}</div>

      <Stack gap="sm" h="100%">
        {/* Icon */}
        <div className={styles.iconContainer}>{icon}</div>

        {/* Content */}
        <div className={styles.contentContainer}>
          <Title order={4} className={styles.cardTitle}>
            {title}
          </Title>
          <Text size="sm" c="dimmed" lh={1.5}>
            {description}
          </Text>
        </div>
      </Stack>
    </Paper>
  );
}

export function GetPaid() {
  const instructionalSteps = [
    {
      step: 1,
      title: 'Earn Red Buzz',
      description:
        'Participate in activities and earn Red Buzz through various platform interactions and contributions.',
      icon: <IconCoin size={24} />,
    },
    {
      step: 2,
      title: 'List on Red Buzz Marketplace',
      description:
        'Set your own price and list your Red Buzz on the marketplace for other users to purchase.',
      icon: <IconShoppingCart size={24} />,
    },
    {
      step: 3,
      title: 'Get Paid via P2P',
      description:
        'Receive payments through your preferred P2P service: Venmo, CashApp, Zelle, Revolut, Wise, and more.',
      icon: <IconCreditCard size={24} />,
    },
  ];

  return (
    <Paper className={classes.tileCard} h="100%">
      <Stack p="md" gap="lg">
        <Title order={3}>Get Paid</Title>

        <Grid gutter="md">
          {instructionalSteps.map((step) => (
            <Grid.Col key={step.step} span={{ base: 12, sm: 6, md: 4 }}>
              <InstructionalCard {...step} />
            </Grid.Col>
          ))}
        </Grid>
      </Stack>
    </Paper>
  );
}
