import { Carousel } from '@mantine/carousel';
import {
  Chip,
  createStyles,
  Grid,
  Group,
  Image,
  Paper,
  Rating,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import dayjs from 'dayjs';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ReviewFilter } from '~/server/common/enums';
import { ModelWithDetails } from '~/server/validators/models/getById';

const useStyles = createStyles(() => ({
  label: {
    textAlign: 'center',
    width: '100%',
  },
  root: {
    textAlign: 'center',
    width: '100%',
  },
}));

export function ModelReview({ items }: Props) {
  const { classes } = useStyles();

  return (
    <Grid gutter="xl">
      <Grid.Col span={2}>
        <Stack>
          <Title order={4}>Filters</Title>
          <Chip.Group align="center" multiple>
            <Chip classNames={classes} radius="xs" value={ReviewFilter.NSFW}>
              NSFW
            </Chip>
            <Chip classNames={classes} radius="xs" value={ReviewFilter.IncludesImages}>
              Includes Images
            </Chip>
          </Chip.Group>
        </Stack>
      </Grid.Col>
      <Grid.Col span={10}>
        {items.length > 0 ? (
          <SimpleGrid
            breakpoints={[
              { minWidth: 'sm', cols: 2 },
              { minWidth: 'md', cols: 3 },
            ]}
          >
            {items.map((review, index) => (
              <ReviewItem key={index} review={review} />
            ))}
          </SimpleGrid>
        ) : (
          <Paper p="xl" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Stack>
              <Text size="xl">There are no reviews for this model yet.</Text>
              <Text color="dimmed">
                Be the first to let the people know about this model by leaving your review.
              </Text>
            </Stack>
          </Paper>
        )}
      </Grid.Col>
    </Grid>
  );
}

type Props = { items: ModelWithDetails['reviews'] };

function ReviewItem({ review }: ItemProps) {
  return (
    <Paper radius="md" p="md" withBorder>
      <Stack>
        <Group align="center" sx={{ justifyContent: 'space-between' }}>
          <Stack spacing={4}>
            <UserAvatar
              user={review.user}
              subText={`${dayjs(review.createdAt).fromNow()} - ${review.modelVersion?.name}`}
              withUsername
            />
          </Stack>
          <Rating value={review.rating} fractions={2} readOnly />
        </Group>
        <Carousel
          sx={(theme) => ({
            margin: `0 ${theme.spacing.md * -1}px`,
          })}
          loop
        >
          {review.imagesOnReviews.map(({ image }) => (
            <Carousel.Slide key={image.id}>
              <Image
                src={image.url}
                alt={image.name ?? 'Visual representation of the user review'}
              />
            </Carousel.Slide>
          ))}
        </Carousel>
        <ContentClamp>
          <Text>{review.text}</Text>
        </ContentClamp>
      </Stack>
    </Paper>
  );
}

type ItemProps = { review: ModelWithDetails['reviews'][number] };
