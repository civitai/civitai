import { Button, Card, Stack, Text, Title } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { CivitaiNewsItem } from '~/server/services/article.service';
import { formatDate } from '~/utils/date-helpers';
import classes from './News.module.css';

export function News({ articles }: { articles: CivitaiNewsItem[] }) {
  return (
    <Stack gap="md">
      {articles.map((article) => (
        <NewsItem key={article.id} article={article} />
      ))}
    </Stack>
  );
}

function NewsItem({ article }: { article: CivitaiNewsItem }) {
  return (
    <Card component={Link} href={`/articles/${article.id}`} className={classes.card} withBorder>
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
