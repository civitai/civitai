import { Button, Card, createStyles, Stack, Text, Title } from '@mantine/core';
import { NextLink } from '@mantine/next';
import type { CivitaiNewsItem } from '~/server/services/article.service';
import { formatDate } from '~/utils/date-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';

export function News({ articles }: { articles: CivitaiNewsItem[] }) {
  return (
    <Stack spacing="md">
      {articles.map((article) => (
        <NewsItem key={article.id} article={article} />
      ))}
    </Stack>
  );
}

function NewsItem({ article }: { article: CivitaiNewsItem }) {
  const { classes, theme } = useStyles();
  return (
    <Card component={NextLink} href={`/articles/${article.id}`} className={classes.card} withBorder>
      <Title order={3} className={classes.title}>
        {article.title}
      </Title>
      <Text className={classes.publishDate}>{formatDate(article.publishedAt)}</Text>
      <Text className={classes.summary}>{article.summary}</Text>
      <Button className={classes.action} variant="outline">
        Read the Article
      </Button>
    </Card>
  );
}

const useStyles = createStyles((theme, _, getRef) => ({
  root: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.white,
    paddingTop: theme.spacing.xl * 2,
    paddingBottom: theme.spacing.xl * 2,
  },

  articles: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: theme.spacing.xl,
  },

  card: {
    display: 'block',
    overflow: 'hidden',
    [`&:hover`]: {
      // backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[1],
      borderColor: theme.colors.blue[7],
    },
    [`&:hover .${getRef('action')}`]: {
      backgroundColor: theme.fn.rgba(
        theme.colors.blue[7],
        theme.colorScheme === 'dark' ? 0.1 : 0.05
      ),
    },
  },

  imageContainer: {
    width: '100%',
    height: 200,
    overflow: 'hidden',
    [`@container (min-width: 800px)`]: {
      width: 200,
      height: 'auto',
    },
  },

  title: {
    fontSize: theme.fontSizes.lg,
    [containerQuery.largerThan('md')]: {
      fontSize: theme.fontSizes.xl,
    },
  },

  publishDate: {
    fontSize: theme.fontSizes.sm,
    color: theme.colorScheme === 'dark' ? theme.colors.dark[2] : theme.colors.gray[6],
  },

  summary: {
    fontSize: theme.fontSizes.md,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.md,
    [containerQuery.largerThan('md')]: {
      fontSize: theme.fontSizes.lg,
    },
  },

  action: {
    ref: getRef('action'),
  },
}));
