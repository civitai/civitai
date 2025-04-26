import React from 'react';
import { ButtonProps, Popover, Text, DefaultMantineColor, Group, ThemeIcon } from '@mantine/core';
import { ScanResultCode } from '~/shared/utils/prisma/enums';
import {
  IconAlertCircle,
  IconCheck,
  IconExclamationMark,
  IconQuestionMark,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { containerQuery } from '~/utils/mantine-css-helpers';
import styles from './VerifiedText.module.scss';
import clsx from 'clsx';

type VerifiedFile = {
  scanResult: ScanResultCode;
  scannedAt: Date;
  scanMessage?: string | null;
};

type Props = {
  file?: VerifiedFile | null;
  iconOnly?: boolean;
};

export function VerifiedText({ file, iconOnly }: Props) {
  if (!file) return null;

  const { scanResult, scannedAt, scanMessage } = file;
  const color: DefaultMantineColor =
    scanResult === ScanResultCode.Success
      ? 'green'
      : scanResult === ScanResultCode.Danger
      ? 'red'
      : scanResult === ScanResultCode.Error
      ? 'orange'
      : 'gray';

  const icon =
    scanResult === ScanResultCode.Success ? (
      <IconCheck size={14} />
    ) : scanResult === ScanResultCode.Danger ? (
      <IconAlertCircle size={14} />
    ) : scanResult === ScanResultCode.Error ? (
      <IconExclamationMark size={14} />
    ) : (
      <IconQuestionMark size={14} />
    );

  const text =
    scanResult === ScanResultCode.Success
      ? 'Verified'
      : scanResult === ScanResultCode.Danger
      ? 'Danger'
      : scanResult === ScanResultCode.Error
      ? 'Error'
      : 'Pending';

  return (
    <Group spacing={4} className={clsx(styles.verified, styles.hideSm)}>
      <ThemeIcon color={color} size="xs">
        {icon}
      </ThemeIcon>
      {!iconOnly && (
        <Popover width={300} position="bottom" withArrow>
          <Popover.Target>
            <Text size="xs" className={styles[color]}>
              {text}
            </Text>
          </Popover.Target>
          <Popover.Dropdown>
            <Text size="sm">
              {scanMessage || text}
              <br />
              <Text size="xs" color="dimmed">
                Scanned {dayjs(scannedAt).fromNow()}
              </Text>
            </Text>
          </Popover.Dropdown>
        </Popover>
      )}
    </Group>
  );
}
