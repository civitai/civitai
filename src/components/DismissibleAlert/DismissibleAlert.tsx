import { Alert, AlertProps, createStyles, Group, MantineColor, Stack, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';

export const DismissibleAlert = ({
  id,
  title,
  content,
  color = 'blue',
  size = 'md',
  emoji,
  icon,
  className,
  ...props
}: DismissibleAlertProps) => {
  const { classes, cx } = useStyles({ color });
  const [dismissed, setDismissed] = useLocalStorage({
    key: `alert-dismissed-${id}`,
    defaultValue: false,
    getInitialValueInEffect: true,
  });

  if (dismissed) return null;

  const contentSize = size === 'md' ? 'sm' : 'xs';

  return (
    <Alert
      py={8}
      {...props}
      className={cx(className, classes.announcement)}
      onClose={() => setDismissed(true)}
      closeButtonLabel="Close alert"
      withCloseButton
    >
      <Group spacing="xs" noWrap>
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
            {content}
          </Text>
        </Stack>
      </Group>
    </Alert>
  );
};

type DismissibleAlertProps = {
  id: string;
  content: React.ReactNode;
  title?: React.ReactNode;
  color?: MantineColor;
  emoji?: string | null;
  icon?: React.ReactNode;
  size?: 'sm' | 'md';
} & Omit<AlertProps, 'color' | 'children'>;

const useStyles = createStyles((theme, { color }: { color: MantineColor }) => ({
  announcement: {
    border: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors[color][9] : theme.colors[color][2]
    }`,
    backgroundColor:
      theme.colorScheme === 'dark'
        ? theme.fn.darken(theme.colors[color][8], 0.5)
        : theme.colors[color][1],
  },
  title: {
    color: theme.colorScheme === 'dark' ? theme.colors[color][0] : theme.colors[color][7],
    lineHeight: 1.1,
  },
  text: {
    color: theme.colorScheme === 'dark' ? theme.colors[color][2] : theme.colors[color][9],
    lineHeight: 1.2,
    '& > div > a': {
      color: theme.colorScheme === 'dark' ? theme.colors[color][1] : theme.colors[color][8],
    },
  },
}));
