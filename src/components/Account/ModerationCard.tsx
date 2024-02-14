import {
  Card,
  Group,
  Stack,
  Switch,
  Title,
  Text,
  SwitchProps,
  Skeleton,
  Chip,
} from '@mantine/core';
import { IconRating18Plus } from '@tabler/icons-react';
import React from 'react';
import { useState, useMemo } from 'react';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { HiddenUsersSection } from '~/components/Account/HiddenUsersSection';
import { MatureContentSettings } from '~/components/Account/MatureContentSettings';
import { BlurToggle } from '~/components/Settings/BlurToggle';
import { useHiddenPreferencesData, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { moderationCategories, ModerationCategory } from '~/libs/moderation';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export function ModerationCard({
  cardless = false,
  sections = ['title', 'tags', 'users', 'nsfw'],
  instantRefresh = true,
}: {
  cardless?: boolean;
  sections?: Array<'title' | 'tags' | 'users' | 'nsfw'>;
  instantRefresh?: boolean;
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
