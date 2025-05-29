import type { CardProps, MantineColor } from '@mantine/core';
import { Box, Button, Stack, Text, Title } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { CivitaiNewsItem } from '~/server/services/article.service';
import { containerQuery } from '~/utils/mantine-css-helpers';
import classes from './FeaturedArticle.module.scss';
import clsx from 'clsx';

export const FeaturedArticle = ({
  article,
  className,
  ...props
}: Omit<CardProps, 'children'> & { article: CivitaiNewsItem }) => {
  return (
    <Box className={clsx(classes.card, className)} {...props}>
      {article.coverImage && (
        <Box className={classes.imageContainer}>
          <EdgeMedia
            src={article.coverImage.url}
            width={512}
            alt={`Cover image for ${article.title}`}
          />
        </Box>
      )}
      <Stack className={classes.stack}>
        <Title className={classes.title} order={2}>
          {article.title}
        </Title>

        <Text className={classes.text}>{article.summary}</Text>

        <Button
          component={Link}
          href={`/articles/${article.id}`}
          size="lg"
          className={classes.action}
          variant="outline"
        >
          Read the Article
        </Button>
      </Stack>
    </Box>
  );
};
