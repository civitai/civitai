import { Box, Button, CardProps, Stack, Text, Title } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { CivitaiNewsItem } from '~/server/services/article.service';
import { containerQuery } from '~/utils/mantine-css-helpers';
import styles from './FeaturedArticle.module.scss';
import clsx from 'clsx';

export const FeaturedArticle = ({
  article,
  className,
  ...props
}: Omit<CardProps, 'children'> & { article: CivitaiNewsItem }) => {
  return (
    <Box className={clsx(styles.card, className)} {...props}>
      {article.coverImage && (
        <Box className={styles.imageContainer}>
          <EdgeMedia
            src={article.coverImage.url}
            width={512}
            alt={`Cover image for ${article.title}`}
          />
        </Box>
      )}
      <Stack className={styles.stack}>
        <Title className={styles.title} order={2}>
          {article.title}
        </Title>

        <Text className={styles.text}>{article.summary}</Text>

        <Button
          component={Link}
          href={`/articles/${article.id}`}
          size="lg"
          className={styles.action}
          variant="outline"
        >
          Read the Article
        </Button>
      </Stack>
    </Box>
  );
};
