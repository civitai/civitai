import {
  Card,
  Divider,
  Group,
  Select,
  Stack,
  Switch,
  Title,
  Text,
  SwitchProps,
  Skeleton,
  Chip,
  Badge,
} from '@mantine/core';
import { IconRating18Plus } from '@tabler/icons';
import React from 'react';
import { useState } from 'react';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { HiddenUsersSection } from '~/components/Account/HiddenUsersSection';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { reloadSession } from '~/utils/next-auth-helpers';
import { invalidateModeratedContent } from '~/utils/query-invalidation-utils';
import { trpc } from '~/utils/trpc';

export function ModerationCard() {
  const user = useCurrentUser();
  const utils = trpc.useContext();
  const [showNsfw, setShowNsfw] = useState(user?.showNsfw ?? false);
  const [preferences, setPreferences] = useState<Record<string, boolean>>({});
  const { isLoading: preferencesLoading } = trpc.moderation.getPreferences.useQuery(undefined, {
    onSuccess: setPreferences,
  });

  const { mutate } = trpc.moderation.updatePreferences.useMutation({
    async onMutate(changes) {
      setPreferences(changes);
    },
    async onSuccess() {
      await invalidateModeratedContent(utils);
    },
  });

  const changePreference = (name: string, value: boolean, children?: ModerationCategory[]) => {
    const changes = { [name]: value };
    if (children && !value)
      children.forEach((child) => {
        changes[child.value] = value;
      });

    mutate({ ...preferences, ...changes });
  };

  const { mutate: updateUser } = trpc.user.update.useMutation({
    async onMutate(changes) {
      setShowNsfw(changes.showNsfw ?? false);
    },
    async onSuccess() {
      await invalidateModeratedContent(utils);
      await reloadSession();
    },
  });

  return (
    <Card withBorder id="content-moderation">
      <Stack spacing={0} mb="md">
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

      <Stack>
        <Card withBorder>
          <Card.Section withBorder inheritPadding py="xs">
            <Text weight={500}>Hidden Tags</Text>
          </Card.Section>
          <HiddenTagsSection />
        </Card>

        <Card withBorder>
          <Card.Section withBorder inheritPadding py="xs">
            <Text weight={500}>Hidden Users</Text>
          </Card.Section>
          <HiddenUsersSection />
        </Card>

        <Card withBorder pb={0}>
          <Card.Section withBorder inheritPadding py="xs">
            <Group position="apart">
              <Text weight={500}>Mature Content</Text>
              <SkeletonSwitch
                loading={!user}
                checked={showNsfw ?? false}
                onChange={(e) => updateUser({ ...user, showNsfw: e.target.checked })}
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
                          Toggle all that your are comfortable seeing
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
      </Stack>
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

type ModerationCategory = {
  label: string;
  value: string;
  hidden?: boolean;
  children?: ModerationCategory[];
};

const moderationCategories: ModerationCategory[] = [
  {
    label: 'Explicit Nudity',
    value: 'explicit nudity',
    children: [
      { label: 'Nudity', value: 'nudity' },
      { label: 'Graphic Male Nudity', value: 'graphic male nudity' },
      { label: 'Graphic Female Nudity', value: 'graphic female nudity' },
      { label: 'Sexual Activity', value: 'sexual activity' },
      { label: 'Illustrated Explicit Nudity', value: 'illustrated explicit nudity' },
      { label: 'Adult Toys', value: 'adult toys' },
    ],
  },
  {
    label: 'Suggestive',
    value: 'suggestive',
    children: [
      { label: 'Female Swimwear Or Underwear', value: 'female swimwear or underwear' },
      { label: 'Male Swimwear Or Underwear', value: 'male swimwear or underwear' },
      { label: 'Partial Nudity', value: 'partial nudity' },
      { label: 'Barechested Male', value: 'barechested male' },
      { label: 'Revealing Clothes', value: 'revealing clothes' },
      { label: 'Sexual Situations', value: 'sexual situations' },
    ],
  },
  {
    label: 'Violence',
    value: 'violence',
    children: [
      { label: 'Graphic Violence Or Gore', value: 'graphic violence or gore' },
      { label: 'Physical Violence', value: 'physical violence' },
      { label: 'Weapon Violence', value: 'weapon violence' },
      { label: 'Weapons', value: 'weapons' },
      { label: 'Self Injury', value: 'self injury', hidden: true },
    ],
  },
  {
    label: 'Visually Disturbing',
    value: 'visually disturbing',
    children: [
      { label: 'Emaciated Bodies', value: 'emaciated bodies' },
      { label: 'Corpses', value: 'corpses' },
      { label: 'Hanging', value: 'hanging', hidden: true },
      { label: 'Air Crash', value: 'air crash', hidden: true },
      { label: 'Explosions And Blasts', value: 'explosions and blasts' },
    ],
  },
  {
    label: 'Rude Gestures',
    value: 'rude gestures',
    children: [{ label: 'Middle Finger', value: 'middle finger' }],
  },
  {
    label: 'Drugs',
    value: 'drugs',
    hidden: true,
    children: [
      { label: 'Drug Products', value: 'drug products' },
      { label: 'Drug Use', value: 'drug use' },
      { label: 'Pills', value: 'pills' },
      { label: 'Drug Paraphernalia', value: 'drug paraphernalia' },
    ],
  },
  {
    label: 'Tobacco',
    value: 'tobacco',
    hidden: true,
    children: [
      { label: 'Tobacco Products', value: 'tobacco products' },
      { label: 'Smoking', value: 'smoking' },
    ],
  },
  {
    label: 'Alcohol',
    value: 'alcohol',
    hidden: true,
    children: [
      { label: 'Drinking', value: 'drinking' },
      { label: 'Alcoholic Beverages', value: 'alcoholic beverages' },
    ],
  },
  {
    label: 'Gambling',
    value: 'gambling',
    hidden: true,
    children: [{ label: 'Gambling', value: 'gambling' }],
  },
  {
    label: 'Hate Symbols',
    value: 'hate symbols',
    hidden: true,
    children: [
      { label: 'Nazi Party', value: 'nazi party' },
      { label: 'White Supremacy', value: 'white supremacy' },
      { label: 'Extremist', value: 'extremist' },
    ],
  },
];
