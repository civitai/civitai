import { Card, Group, Stack, Title, Text } from '@mantine/core';
import React from 'react';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { HiddenUsersSection } from '~/components/Account/HiddenUsersSection';
import { MatureContentSettings } from '~/components/Account/MatureContentSettings';

export function ModerationCard({
  cardless = false,
  sections = ['title', 'tags', 'users', 'nsfw'],
}: {
  cardless?: boolean;
  sections?: Array<'title' | 'tags' | 'users' | 'nsfw'>;
}) {
  const content = (
    <Stack>
      {sections.includes('title') && (
        <Stack key="title" spacing={0} mb="md">
          <Group spacing="xs">
            <Title order={2}>Content Moderation</Title>
          </Group>
          <Text color="dimmed" size="sm">
            {`Choose the type of content you don't want to see on the site.`}
          </Text>
        </Stack>
      )}
      {sections.includes('tags') && <HiddenTagsSection key="tags" />}
      {sections.includes('users') && <HiddenUsersSection />}
      {sections.includes('nsfw') && <MatureContentSettings />}
    </Stack>
  );
  if (cardless) return content;
  return (
    <Card withBorder id="content-moderation">
      {content}
    </Card>
  );
}
