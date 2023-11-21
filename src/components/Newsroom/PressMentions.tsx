import { Card, createStyles, Text, Title } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { PressMention } from '@prisma/client';
import { formatDate } from '~/utils/date-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';

export function PressMentions({ pressMentions }: { pressMentions: PressMention[] }) {
  const { classes } = useStyles();

  return (
    <div className={classes.articles}>
      {pressMentions.map((pressMention) => (
        <PressMentionItem key={pressMention.id} pressMention={pressMention} />
      ))}
    </div>
  );
}

export function PressMentionItem({ pressMention }: { pressMention: PressMention }) {
  const { classes } = useStyles();

  return (
    <Card component={NextLink} href={pressMention.url} className={classes.card} withBorder>
      <Text className={classes.source}>{pressMention.source}</Text>
      <Title order={3} className={classes.title}>
        {pressMention.title}
      </Title>
      <Text className={classes.publishDate}>{formatDate(pressMention.publishedAt)}</Text>
    </Card>
  );
}

const useStyles = createStyles((theme, _, getRef) => ({
  articles: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
    gap: theme.spacing.md,
  },

  card: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    height: '100%',
    padding: theme.spacing.md,
    transition: 'all 200ms ease',
    '&:hover': {
      borderColor: theme.colors.blue[7],
    },
  },

  title: {
    fontSize: theme.fontSizes.lg,
    flex: 1,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.md,
    [containerQuery.largerThan('md')]: {
      fontSize: theme.fontSizes.xl,
    },
  },

  publishDate: {
    fontSize: theme.fontSizes.md,
    color: theme.colorScheme === 'dark' ? theme.colors.dark[2] : theme.colors.gray[6],
  },

  source: {
    color: theme.colorScheme === 'dark' ? theme.colors.blue[3] : theme.colors.blue[6],
    fontSize: theme.fontSizes.md,
  },
}));
