import { CardProps, Card, Stack, Text, Title, createStyles } from '@mantine/core';

const useStyles = createStyles((theme) => ({
  card: {
    padding: '32px !important',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    [theme.fn.smallerThan('sm')]: {
      padding: '16px !important',
    },
  },
}));

export function SectionCard({
  title,
  subtitle,
  children,
  headerAlign = 'center',
  ...cardProps
}: Props) {
  const { classes } = useStyles();
  return (
    <Card className={classes.card} radius="lg" {...cardProps}>
      <Stack align="center" spacing={48}>
        {(title || subtitle) && (
          <Stack spacing={4} align={headerAlign}>
            {title && (
              <Title order={2} size={32} align={headerAlign}>
                {title}
              </Title>
            )}
            {subtitle && (
              <Text color="dimmed" size="xl" align={headerAlign}>
                {subtitle}
              </Text>
            )}
          </Stack>
        )}
        {children}
      </Stack>
    </Card>
  );
}

type Props = CardProps & {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  headerAlign?: React.CSSProperties['textAlign'];
};
