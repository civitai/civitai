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
  Badge,
} from '@mantine/core';
import { IconRating18Plus } from '@tabler/icons-react';
import { debounce } from 'lodash-es';
import React from 'react';
import { useState, useMemo } from 'react';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { HiddenUsersSection } from '~/components/Account/HiddenUsersSection';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { moderationCategories, ModerationCategory } from '~/libs/moderation';
import { invalidateModeratedContentDebounced } from '~/utils/query-invalidation-utils';
import { trpc } from '~/utils/trpc';

export function ModerationCard({
  cardless = false,
  sections = ['title', 'tags', 'users', 'nsfw'],
  instantRefresh = true,
}: {
  cardless?: boolean;
  sections?: Array<'title' | 'tags' | 'users' | 'nsfw'>;
  instantRefresh?: boolean;
}) {
  const user = useCurrentUser();
  const utils = trpc.useContext();
  const [showNsfw, setShowNsfw] = useState(user?.showNsfw ?? false);
  const [preferences, setPreferences] = useState<Record<string, boolean>>({});
  const { isLoading: preferencesLoading } = trpc.moderation.getPreferences.useQuery(undefined, {
    onSuccess: setPreferences,
    cacheTime: 0, // So that if they navigate away we refetch...
  });

  const { mutate } = trpc.moderation.updatePreferences.useMutation({
    async onSuccess() {
      if (!instantRefresh) return;
      invalidateModeratedContentDebounced(utils, ['tag']);
    },
  });
  const mutateDebounced = useMemo(() => debounce(mutate, 500), [mutate]);

  const changePreference = (name: string, value: boolean, children?: ModerationCategory[]) => {
    const changes = { [name]: value };
    if (children) for (const child of children) changes[child.value] = value;

    const values = { ...preferences, ...changes };
    setPreferences(values);
    mutateDebounced(values);
  };

  const { mutate: updateUser } = trpc.user.update.useMutation({
    async onMutate(changes) {
      // If all preferences are false, set them all to true
      if (changes.showNsfw) {
        const isEmpty = !moderationCategories.some((x) => preferences[x.value] && !x.hidden);
        if (isEmpty) {
          const values = { ...preferences };
          for (const category of moderationCategories) {
            if (category.hidden) continue;
            values[category.value] = true;
            for (const child of category.children ?? []) {
              if (child.hidden) continue;
              values[child.value] = true;
            }
          }
          setPreferences(values);
          mutateDebounced(values);
        }
      }
      setShowNsfw(changes.showNsfw ?? false);
    },
    async onSuccess() {
      if (!instantRefresh) return;
      invalidateModeratedContentDebounced(utils, ['tag']);
      user?.refresh();
    },
  });

  const title = (
    <Stack key="title" spacing={0} mb="md">
      <Group spacing="xs">
        <Title order={2}>Content Moderation</Title>
        <Badge color="yellow" size="xs">
          Beta
        </Badge>
      </Group>
      <Text color="dimmed" size="sm">
        {`Choose the type of content you don't want to see on the site.`}
      </Text>
    </Stack>
  );

  const tags = (
    <Card key="tags" withBorder>
      <Card.Section withBorder inheritPadding py="xs">
        <Text weight={500}>Hidden Tags</Text>
      </Card.Section>
      <HiddenTagsSection />
    </Card>
  );

  const users = (
    <Card key="users" withBorder>
      <Card.Section withBorder inheritPadding py="xs">
        <Text weight={500}>Hidden Users</Text>
      </Card.Section>
      <HiddenUsersSection />
    </Card>
  );

  const nsfw = (
    <Card key="nsfw" withBorder pb={0}>
      <Card.Section withBorder inheritPadding py="xs">
        <Group position="apart">
          <Text weight={500}>Mature Content</Text>
          <SkeletonSwitch
            loading={!user}
            checked={showNsfw ?? false}
            onChange={(e) => !!user?.id && updateUser({ id: user.id, showNsfw: e.target.checked })}
          />
        </Group>
      </Card.Section>
      {!showNsfw ? (
        <Group noWrap mt="xs" pb="sm">
          <IconRating18Plus size={48} strokeWidth={1.5} />
          <Text sx={{ lineHeight: 1.3 }}>
            {`By enabling Mature Content, you confirm you are over the age of 18.`}
          </Text>
        </Group>
      ) : (
        <>
          {moderationCategories
            .filter((x) => !x.hidden)
            .map((category) => (
              <React.Fragment key={category.value}>
                <Card.Section withBorder inheritPadding py="xs">
                  <Group position="apart">
                    <Text weight={500}>{category.label}</Text>
                    <SkeletonSwitch
                      loading={preferencesLoading}
                      checked={preferences?.[category.value] ?? false}
                      onChange={(e) =>
                        changePreference(category.value, e.target.checked, category.children)
                      }
                    />
                  </Group>
                </Card.Section>
                {preferences && preferences[category.value] && !!category.children?.length && (
                  <Card.Section inheritPadding py="md">
                    <Text size="xs" weight={500} mb="xs" mt={-8} color="dimmed">
                      Toggle all that you are comfortable seeing
                    </Text>
                    <Group spacing={5}>
                      {category.children
                        .filter((x) => !x.hidden)
                        .map((child) => (
                          <Chip
                            variant="filled"
                            radius="xs"
                            size="xs"
                            key={child.value}
                            onChange={(checked) => changePreference(child.value, checked)}
                            checked={preferences?.[child.value] ?? false}
                          >
                            {child.label}
                          </Chip>
                        ))}
                    </Group>
                  </Card.Section>
                )}
              </React.Fragment>
            ))}
        </>
      )}
    </Card>
  );
  const contentSections = { title, tags, users, nsfw };

  const content = <Stack>{sections.map((x) => contentSections[x])}</Stack>;
  if (cardless) return content;
  return (
    <Card withBorder id="content-moderation">
      {content}
    </Card>
  );
}

const SkeletonSwitch = ({ loading, ...props }: { loading: boolean } & SwitchProps) => {
  return (
    <Skeleton height={20} width={40} radius="lg" visible={loading}>
      <Switch {...props} />
    </Skeleton>
  );
};
