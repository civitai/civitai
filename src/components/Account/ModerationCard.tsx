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
import React from 'react';
import { useState, useMemo } from 'react';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { HiddenUsersSection } from '~/components/Account/HiddenUsersSection';
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
  const user = useCurrentUser();
  const [showNsfw, setShowNsfw] = useState(user?.showNsfw ?? false);

  const tags = useHiddenPreferencesData().tag;
  const hiddenTags = tags.filter((x) => x.type === 'hidden').map((x) => x.id);
  const moderationTags = tags.filter((x) => x.type === 'moderated');

  const preferences = useMemo(
    () =>
      moderationTags?.reduce<Record<string, boolean>>(
        (acc, value) => ({ ...acc, [value.name]: !hiddenTags.includes(value.id) }),
        {}
      ) ?? {},
    [moderationTags, hiddenTags]
  );

  const { mutate, isLoading } = useToggleHiddenPreferences();

  const handleCategoryToggle = async (
    name: string,
    value: boolean,
    children?: ModerationCategory[]
  ) => {
    if (!children) return;
    const childValues = children.map((x) => x.value);
    const valueTag = moderationTags.find((x) => x.name === name);
    const data = [valueTag, ...moderationTags.filter((x) => childValues.includes(x.name))].filter(
      isDefined
    );
    mutate({ kind: 'tag', data, hidden: !value });
  };

  const handleChipToggle = (name: string, value: boolean) => {
    const tag = moderationTags.find((x) => x.name === name);
    if (!!tag) mutate({ kind: 'tag', data: [{ ...tag }], hidden: !value });
  };

  const { mutate: updateUser } = trpc.user.update.useMutation({
    async onMutate(changes) {
      setShowNsfw(changes.showNsfw ?? false);
    },
    async onSuccess() {
      if (!instantRefresh) return;
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

  const tagSection = (
    <Card key="tags" withBorder>
      <Card.Section withBorder inheritPadding py="xs">
        <Text weight={500}>Hidden Tags</Text>
      </Card.Section>
      <HiddenTagsSection />
    </Card>
  );

  const userSection = (
    <Card key="users" withBorder>
      <Card.Section withBorder inheritPadding py="xs">
        <Text weight={500}>Hidden Users</Text>
      </Card.Section>
      <HiddenUsersSection />
    </Card>
  );

  const nsfwSection = (
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
            .map((category) => {
              const categoryChecked = category.children?.some((x) => preferences[x.value]);
              return (
                <React.Fragment key={category.value}>
                  <Card.Section withBorder inheritPadding py="xs">
                    <Group position="apart">
                      <Text weight={500}>{category.label}</Text>
                      <SkeletonSwitch
                        loading={isLoading}
                        checked={categoryChecked}
                        onChange={(e) =>
                          handleCategoryToggle(category.value, e.target.checked, category.children)
                        }
                      />
                    </Group>
                  </Card.Section>
                  {preferences && categoryChecked && !!category.children?.length && (
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
                              onChange={(checked) => handleChipToggle(child.value, checked)}
                              checked={preferences?.[child.value] ?? false}
                            >
                              {child.label}
                            </Chip>
                          ))}
                      </Group>
                    </Card.Section>
                  )}
                </React.Fragment>
              );
            })}
        </>
      )}
    </Card>
  );
  const contentSections = { title, tags: tagSection, users: userSection, nsfw: nsfwSection };

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
