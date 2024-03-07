import {
  Card,
  Stack,
  Group,
  Rating,
  Badge,
  Center,
  Text,
  Button,
  ScrollArea,
  ThemeIcon,
} from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { IconPhoto, IconMessageCircle2 } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ResourceReviewInfiniteModel } from '~/types/router';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';

export function ResourceReviewCard({ data }: { data: ResourceReviewInfiniteModel }) {
  const isThumbsUp = data.recommended;

  return (
    <Card p="xs">
      <Stack>
        <UserAvatar user={data.user} withUsername withLink />
        {data.recommended && (
          <Group position="apart">
            <ThemeIcon
              variant="light"
              size="lg"
              radius="md"
              color={isThumbsUp ? 'success.5' : 'red'}
            >
              {isThumbsUp ? <ThumbsUpIcon filled /> : <ThumbsUpIcon filled />}
            </ThemeIcon>
            {/* {data.helper?.imageCount && (
              <Badge
                leftSection={
                  <Center>
                    <IconPhoto size={14} />
                  </Center>
                }
              >
                {data.helper.imageCount}
              </Badge>
            )} */}
          </Group>
        )}
        {data.details && (
          <ScrollArea.Autosize maxHeight={200}>
            <RenderHtml html={data.details} sx={(theme) => ({ fontSize: theme.fontSizes.sm })} />
          </ScrollArea.Autosize>
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
