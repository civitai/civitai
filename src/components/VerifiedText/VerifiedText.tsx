import {
  ButtonProps,
  Popover,
  Text,
  DefaultMantineColor,
  Group,
  ThemeIcon,
  createStyles,
} from '@mantine/core';
import { ScanResultCode } from '@prisma/client';
import { IconShieldCheck, IconShieldOff, IconShieldX } from '@tabler/icons-react';
import ReactMarkdown from 'react-markdown';
import dayjs from 'dayjs';

type VerifiedFile = {
  virusScanResult: ScanResultCode;
  virusScanMessage: string | null;
  pickleScanResult: ScanResultCode;
  pickleScanMessage: string | null;
  scannedAt: Date | null;
};
type Props = Omit<ButtonProps, 'children'> & { file: VerifiedFile | undefined; iconOnly?: boolean };
const statusColors: Record<ScanResultCode, DefaultMantineColor> = {
  Pending: 'gray',
  Success: 'green',
  Danger: 'red',
  Error: 'orange',
};
const statusIcon: Record<ScanResultCode, JSX.Element> = {
  Pending: <IconShieldOff size={16} />,
  Success: <IconShieldCheck size={16} />,
  Danger: <IconShieldX size={16} />,
  Error: <IconShieldOff size={16} />,
};
const statusMessage: Record<ScanResultCode, string> = {
  Pending: "This file hasn't been scanned yet, check back soon.",
  Success: 'This file appears to be safe.',
  Danger: 'This file appears to be dangerous.',
  Error: "We couldn't scan this file. Be extra cautious.",
};

const StatusCodeOrder = ['Pending', 'Danger', 'Error', 'Success'] as const;

export function VerifiedText({ file, iconOnly }: Props) {
  const { classes } = useStyles();
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
    <Group spacing={4} noWrap>
      <ThemeIcon color={color} size="xs">
        {icon}
      </ThemeIcon>
      {!iconOnly ? (
        <Text color="dimmed" size="xs">
          <Text component="span">{verified ? 'Verified' : 'Unverified'}: </Text>
          <Popover withArrow width={350} position="bottom" withinPortal>
            <Popover.Target>
              <Text component="a" sx={{ cursor: 'pointer' }}>
                {scannedDate ? (
                  <abbr title={scannedDate.format()}>{scannedDate.fromNow()}</abbr>
                ) : (
                  <>Scan requested</>
                )}
              </Text>
            </Popover.Target>
            <Popover.Dropdown>
              <Text weight={500} size="md" color={verified ? 'green' : 'red'} pb={5}>
                File {verified ? 'Verified' : 'Unverified'}
              </Text>
              <Text pb={5}>{defaultMessage}</Text>
              {virusScanMessage && (
                <ReactMarkdown className="popover-markdown">{virusScanMessage}</ReactMarkdown>
              )}
              {pickleScanMessage && (
                <ReactMarkdown className="popover-markdown">{pickleScanMessage}</ReactMarkdown>
              )}
              <Text
                component="a"
                href="https://github.com/civitai/civitai/wiki/Model-Safety-Checks"
                target="_blank"
                size="xs"
                color="dimmed"
                td="underline"
              >
                What does this mean?
              </Text>
            </Popover.Dropdown>
          </Popover>
        </Text>
      ) : null}
    </Group>
  );
}

const useStyles = createStyles((theme) => ({
  hideSm: {
    [theme.fn.smallerThan('md')]: {
      display: 'none',
    },
  },
}));
