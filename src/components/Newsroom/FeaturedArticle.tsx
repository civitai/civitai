import {
  Box,
  Button,
  CardProps,
  createStyles,
  MantineColor,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { CivitaiNewsItem } from '~/server/services/article.service';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const FeaturedArticle = ({
  article,
  className,
  ...props
}: Omit<CardProps, 'children'> & { article: CivitaiNewsItem }) => {
  const { classes, cx } = useStyles({ color: 'blue' });
  return (
    <Box className={cx(classes.card, className)} {...props}>
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
          component={NextLink}
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

const useStyles = createStyles((theme, { color }: { color: MantineColor }, getRef) => ({
  card: {
    display: 'block',
    borderRadius: theme.radius.md,
    background: theme.colors.blue[9],
    color: '#fff',
    overflow: 'hidden',
    [`& .${getRef('stack')}`]: {
      padding: theme.spacing.lg,
    },
    [`@container (min-width: 800px)`]: {
      display: 'flex',
      minHeight: '100%',
      alignItems: 'stretch',
      borderColor: theme.colors[color][4],
      [`& .${getRef('stack')}`]: {
        padding: `30px ${theme.spacing.lg}px`,
      },
    },
  },
  imageContainer: {
    height: 200,
    width: '100%',

    [`@container (min-width: 800px)`]: {
      width: 300,
      height: 'auto',
      marginRight: theme.spacing.lg,
      borderBottom: 'none',
    },
    img: {
      objectFit: 'cover',
      width: '100%',
      height: '100%',
    },
  },
  stack: {
    ref: getRef('stack'),
    flex: '1',
  },
  title: {
    fontSize: theme.fontSizes.lg,
    [containerQuery.largerThan('md')]: {
      fontSize: theme.fontSizes.xl,
    },
  },
  text: {
    fontSize: theme.fontSizes.md,
    [containerQuery.largerThan('md')]: {
      fontSize: theme.fontSizes.lg,
    },
  },
  action: {
    alignSelf: 'flex-start',
    color: '#fff',
    borderColor: '#fff',
    borderWidth: 2,
    ['&:hover']: {
      backgroundColor: theme.colors.blue[8],
    },
  },
}));
