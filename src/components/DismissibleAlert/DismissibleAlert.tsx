import { Alert, AlertProps, Group, MantineColor, Stack, Text } from '@mantine/core';
import { StorageType, useStorage } from '~/hooks/useStorage';
import { useIsClient } from '~/providers/IsClientProvider';
import classes from './DismissibleAlert.module.scss';

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
  return (
    <Alert
      py={8}
      {...props}
      className={className}
      onClose={onDismiss}
      closeButtonLabel="Close alert"
      withCloseButton={!!onDismiss}
    >
      <Group spacing="xs" noWrap pr="xs">
        {emoji && (
          <Text size={36} p={0} sx={{ lineHeight: 1.2 }}>
            {emoji}
          </Text>
        )}
        {icon}
        <Stack spacing={0}>
          {title && (
            <Text size={size} weight={500} className={classes.title} mb={4}>
              {title}
            </Text>
          )}
          <Text size={contentSize} className={classes.text}>
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

