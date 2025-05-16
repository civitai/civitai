import {
  Alert,
  AlertProps,
  Group,
  MantineColor,
  MantineTheme,
  Stack,
  Text,
  useComputedColorScheme,
  useMantineTheme,
  darken,
} from '@mantine/core';
import { StorageType, useStorage } from '~/hooks/useStorage';
import { useIsClient } from '~/providers/IsClientProvider';
import clsx from 'clsx';

export const DismissibleAlert = (props: DismissibleAlertProps) => {
  const isClient = useIsClient();
  if (!isClient) return null;
  if (!props.id) {
    return <AlertContentInner {...props} />;
  }
  return <AlertDismissable {...props} />;
};

function AlertDismissable({
  id,
  getInitialValueInEffect = true,
  storage = 'localStorage',
  ...props
}: DismissibleAlertProps) {
  const [dismissed, setDismissed] = useStorage({
    type: storage,
    key: `alert-dismissed-${id}`,
    defaultValue:
      typeof window !== 'undefined'
        ? window?.localStorage?.getItem(`alert-dismissed-${id}`) === 'true'
        : false,
    getInitialValueInEffect,
  });

  if (dismissed) return null;

  return <AlertContentInner onDismiss={() => setDismissed(true)} {...props} />;
}

function AlertContentInner({
  id,
  title,
  content,
  color = 'blue',
  size = 'md',
  emoji,
  icon,
  className,
  children,
  onDismiss,
  ...props
}: DismissibleAlertProps & { onDismiss?: () => void }) {
  const contentSize = size === 'md' ? 'sm' : 'xs';
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const styles = getStyle({ color, theme, colorScheme });

  return (
    <Alert
      py={8}
      {...props}
      className={clsx(className)}
      style={styles.announcement}
      onClose={onDismiss}
      closeButtonLabel="Close alert"
      withCloseButton={!!onDismiss}
    >
      <Group gap="xs" wrap="nowrap" pr="xs">
        {emoji && (
          <Text fz={36} p={0} style={{ lineHeight: 1.2 }}>
            {emoji}
          </Text>
        )}
        {icon}
        <Stack gap={0}>
          {title && (
            <Text size={size} weight={500} style={styles.title} mb={4}>
              {title}
            </Text>
          )}
          <Text size={contentSize} style={styles.text}>
            {children ?? content}
          </Text>
        </Stack>
      </Group>
    </Alert>
  );
}

type DismissibleAlertProps = {
  id?: string;
  content?: React.ReactNode;
  children?: React.ReactNode;
  title?: React.ReactNode;
  color?: MantineColor;
  emoji?: string | null;
  icon?: React.ReactNode;
  size?: 'sm' | 'md';
  getInitialValueInEffect?: boolean;
  storage?: StorageType;
} & Omit<AlertProps, 'color' | 'children'>;

const getStyle = ({
  color,
  theme,
  colorScheme,
}: {
  color: MantineColor;
  theme: MantineTheme;
  colorScheme: 'light' | 'dark';
}) => ({
  announcement: {
    border: `1px solid ${colorScheme === 'dark' ? theme.colors[color][9] : theme.colors[color][2]}`,
    backgroundColor:
      colorScheme === 'dark' ? darken(theme.colors[color][8], 0.5) : theme.colors[color][1],
  },
  title: {
    color: colorScheme === 'dark' ? theme.colors[color][0] : theme.colors[color][7],
    lineHeight: 1.1,
  },
  text: {
    color: colorScheme === 'dark' ? theme.colors[color][2] : theme.colors[color][9],
    lineHeight: 1.2,
    '& > div > a': {
      color: colorScheme === 'dark' ? theme.colors[color][1] : theme.colors[color][8],
    },
  },
});
