import type { ButtonProps, DefaultMantineColor } from '@mantine/core';
import { Button, Popover, Text, Group } from '@mantine/core';
import { ScanResultCode } from '~/shared/utils/prisma/enums';
import { IconShieldCheck, IconShieldOff, IconShieldX } from '@tabler/icons-react';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import dayjs from '~/shared/utils/dayjs';

type VerifiedFile = {
  virusScanResult: ScanResultCode;
  virusScanMessage: string | null;
  pickleScanResult: ScanResultCode;
  pickleScanMessage: string | null;
  scannedAt: Date | null;
};
type Props = { file: VerifiedFile | undefined } & Omit<ButtonProps, 'children'>;
const statusColors: Record<ScanResultCode, DefaultMantineColor> = {
  Pending: 'gray',
  Success: 'green',
  Danger: 'red',
  Error: 'orange',
};
const statusIcon: Record<ScanResultCode, JSX.Element> = {
  Pending: <IconShieldOff />,
  Success: <IconShieldCheck />,
  Danger: <IconShieldX />,
  Error: <IconShieldOff />,
};
const statusMessage: Record<ScanResultCode, string> = {
  Pending: "This file hasn't been scanned yet, check back soon.",
  Success: 'This file appears to be safe.',
  Danger: 'This file appears to be dangerous.',
  Error: "We couldn't scan this file. Be extra cautious.",
};

const StatusCodeOrder = ['Pending', 'Danger', 'Error', 'Success'] as const;

export function VerifiedShield({ file, ...props }: Props) {
  if (!file) return null;

  const { virusScanResult, virusScanMessage, pickleScanResult, pickleScanMessage, scannedAt } =
    file;

  const minimumStatus =
    StatusCodeOrder.find((code) => code === virusScanResult || code === pickleScanResult) ??
    ScanResultCode.Pending;
  const color = statusColors[minimumStatus];
  const icon = statusIcon[minimumStatus];
  const defaultMessage = statusMessage[minimumStatus];
  const verified = minimumStatus === ScanResultCode.Success;
  const scannedDate = !scannedAt ? null : dayjs(scannedAt);

  return (
    <Popover withArrow width={350} position="bottom-end">
      <Popover.Target>
        <Button
          color={color}
          style={{ cursor: 'pointer', paddingLeft: 0, paddingRight: 0, width: '36px' }}
          {...props}
        >
          {icon}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Text fw={500} size="md" c={verified ? 'green' : 'red'} pb={5}>
          File {verified ? 'Verified' : 'Unverified'}
        </Text>
        <Text pb={5}>{defaultMessage}</Text>
        {virusScanMessage && (
          <CustomMarkdown className="popover-markdown">{virusScanMessage}</CustomMarkdown>
        )}
        {pickleScanMessage && (
          <CustomMarkdown className="popover-markdown">{pickleScanMessage}</CustomMarkdown>
        )}
        <Group justify="space-between">
          {scannedDate && (
            <Text size="xs" c="dimmed">
              Scanned: <abbr title={scannedDate.format()}>{scannedDate.fromNow()}</abbr>
            </Text>
          )}
          <Text
            component="a"
            href="https://github.com/civitai/civitai/wiki/Model-Safety-Checks"
            target="_blank"
            rel="nofollow noreferrer"
            size="xs"
            c="dimmed"
            td="underline"
          >
            What does this mean?
          </Text>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}
