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
} from '@mantine/core';
import { useState } from 'react';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { HiddenUsersSection } from '~/components/Account/HiddenUsersSection';
import { invalidateModeratedContent } from '~/utils/query-invalidation-utils';
import { trpc } from '~/utils/trpc';

export function ModerationCard() {
  const utils = trpc.useContext();
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
    console.log({ changes });
    if (children)
      children.forEach((child) => {
        changes[child.value] = value;
      });

    mutate({ ...preferences, ...changes });
  };

  return (
    <Card withBorder>
      <Stack spacing={0} mb="md">
        <Title order={2}>Content Moderation</Title>
        <Text color="dimmed" size="sm">
          {`Choose the type of content you're ok seeing on the site.`}
        </Text>
      </Stack>
      <Stack>
        {moderationCategories
          .filter((x) => !x.hidden)
          .map((category) => (
            <Card key={category.value} withBorder>
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
                  <Group spacing={5}>
                    {category.children.map((child) => (
                      <Chip
                        variant="filled"
                        radius="xs"
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
            </Card>
          ))}

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
      { label: 'Self Injury', value: 'self injury' },
    ],
  },
  {
    label: 'Visually Disturbing',
    value: 'visually disturbing',
    children: [
      { label: 'Emaciated Bodies', value: 'emaciated bodies' },
      { label: 'Corpses', value: 'corpses' },
      { label: 'Hanging', value: 'hanging' },
      { label: 'Air Crash', value: 'air crash' },
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
