import { Card, Stack, Group, Rating, Badge, Center, Text, Button, ScrollArea } from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { IconPhoto, IconMessageCircle2 } from '@tabler/icons';
import { abbreviateNumber } from '~/utils/number-helpers';
import { ResourceReviewInfiniteModel } from '~/server/controllers/resourceReview.controller';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';

export function ResourceReviewCard({ data }: { data: ResourceReviewInfiniteModel }) {
  return (
    <Card p="xs">
      <Stack>
        <UserAvatar user={data.user} withUsername withLink />
        {data.rating && (
          <Group position="apart">
            <Rating value={data.rating ?? undefined} readOnly />
            {data.helper?.imageCount && (
              <Badge
                leftSection={
                  <Center>
                    <IconPhoto size={14} />
                  </Center>
                }
              >
                {data.helper.imageCount}
              </Badge>
            )}
          </Group>
        )}
        {data.details && (
          <div style={{ maxHeight: 200, overflow: 'hidden' }}>
            <RenderHtml html={data.details} sx={(theme) => ({ fontSize: theme.fontSizes.sm })} />
          </div>
        )}
      </Stack>
      <Card.Section>
        <Group p="xs" position="apart">
          <span>{/* TODO.posts  - Reactions */}</span>
          <Button size="xs" radius="xl" variant="subtle" compact>
            <Group spacing={2} noWrap>
              <IconMessageCircle2 size={14} />
              {data.thread && <Text>{abbreviateNumber(data.thread._count.comments)}</Text>}
            </Group>
          </Button>
        </Group>
      </Card.Section>
    </Card>
  );
}
