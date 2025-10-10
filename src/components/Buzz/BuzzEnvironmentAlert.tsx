import { Button, Card, Group, Text, ThemeIcon } from '@mantine/core';
import { IconExternalLink, IconInfoCircle } from '@tabler/icons-react';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import classes from './BuzzEnvironmentAlert.module.scss';

interface BuzzEnvironmentAlertProps {
  /**
   * The buzz type of the membership that was detected
   */
  buzzType: BuzzSpendType;
  /**
   * Callback when the user clicks the "View Membership" button
   */
  onViewMembership: () => void;
  /**
   * Custom button text (optional)
   */
  buttonText?: string;
  /**
   * Custom message (optional)
   */
  message?: string;
}

export function BuzzEnvironmentAlert({
  buzzType,
  onViewMembership,
  buttonText,
  message,
}: BuzzEnvironmentAlertProps) {
  const buzzConfig = useBuzzCurrencyConfig(buzzType);
  const buzzName = buzzType === 'green' ? 'Green' : buzzType === 'yellow' ? 'Yellow' : 'Blue';

  return (
    <Card
      padding="md"
      radius="md"
      className={`${classes.alert}`}
      style={{
        // @ts-ignore
        '--buzz-color': buzzConfig?.colorRgb,
      }}
    >
      <Group justify="space-between" wrap="nowrap" align="center">
        <Group gap="md" wrap="nowrap" style={{ flex: 1 }}>
          <ThemeIcon
            size="lg"
            radius="xl"
            w={40}
            h={40}
            className={`${buzzConfig?.classNames?.gradient} ${classes.icon}`}
          >
            <IconInfoCircle size={24} />
          </ThemeIcon>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" fw={700} className={classes.title}>
              <Text component="span" fw={700} className={classes.buzzColoredText}>
                {buzzName}
              </Text>{' '}
              Membership Detected
            </Text>
            <Text size="xs" className={classes.subtitle}>
              {message || `You have an active ${buzzName} membership`}
            </Text>
          </div>
        </Group>
        <Button
          size="sm"
          radius="md"
          rightSection={<IconExternalLink size={16} />}
          onClick={onViewMembership}
          className={`${buzzConfig?.classNames?.btn} ${classes.button}`}
        >
          {buttonText || 'View Membership'}
        </Button>
      </Group>
    </Card>
  );
}
