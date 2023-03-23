import { Card, Stack, Group, Rating, Badge, Center, Text, Button } from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { DiscussionItemInfiniteModel } from '~/server/services/discussion-item.service';
import { IconPhoto, IconMessageCircle2 } from '@tabler/icons';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { abbreviateNumber } from '~/utils/number-helpers';

export function DiscussionItemsCard({
  discussionItem,
}: {
  discussionItem: DiscussionItemInfiniteModel;
}) {
  return (
    <Card p="xs">
      <Stack>
        <UserAvatar />
        {discussionItem.rating && (
          <Group position="apart">
            <Rating value={discussionItem.rating ?? undefined} readOnly />
            {discussionItem.imageCount && (
              <Badge
                leftSection={
                  <Center>
                    <IconPhoto size={14} />
                  </Center>
                }
              >
                {discussionItem.imageCount}
              </Badge>
            )}
          </Group>
        )}
        <ContentClamp maxHeight={100}>
          <Text>{discussionItem.content}</Text>
        </ContentClamp>
      </Stack>
      <Card.Section>
        <Group p="xs" position="apart">
          <span>{/* TODO.posts  - Reactions */}</span>
          <Button size="xs" radius="xl" variant="subtle" compact>
            <Group spacing={2} noWrap>
              <IconMessageCircle2 size={14} />
              <Text>{abbreviateNumber(discussionItem.thread._count.comments)}</Text>
            </Group>
          </Button>
        </Group>
      </Card.Section>
    </Card>
  );
}
