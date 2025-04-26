import { Button, Card, Stack, Text, Title } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { CivitaiNewsItem } from '~/server/services/article.service';
import { formatDate } from '~/utils/date-helpers';
import styles from './News.module.scss';

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
  return (
    <Card component={Link} href={`/articles/${article.id}`} className={styles.card} withBorder>
      <Title order={3} className={styles.title}>
        {article.title}
      </Title>
      <Text className={styles.publishDate}>{formatDate(article.publishedAt)}</Text>
      <Text className={styles.summary}>{article.summary}</Text>
      <Button className={styles.action} variant="outline">
        Read the Article
      </Button>
    </Card>
  );
}

