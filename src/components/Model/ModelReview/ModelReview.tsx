import { Chip, Grid, Group, Paper, Rating, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ModelWithDetails } from '~/server/validators/models/getById';

export function ModelReview({ items }: Props) {
  return (
    <Grid gutter="lg">
      <Grid.Col span={2}>
        <Stack>
          <Title order={4}>Filters</Title>
          <Chip.Group>
            <Stack>
              <Chip>Model Versions</Chip>
              <Chip>NSFW</Chip>
              <Chip>Includes Images</Chip>
            </Stack>
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
          <UserAvatar user={review.user} withUsername />
          <Rating value={review.rating} fractions={2} readOnly />
        </Group>
        <Text>{review.text}</Text>
      </Stack>
    </Paper>
  );
}

type ItemProps = { review: ModelWithDetails['reviews'][number] };
