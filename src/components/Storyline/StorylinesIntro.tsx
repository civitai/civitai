import { Button, Card, CloseButton, Group, Text, ThemeIcon, Title } from '@mantine/core';
import { IconBook2, IconBrush, IconGitFork, IconRoute } from '@tabler/icons-react';
import { StartStorylineButton } from '~/components/Storyline/StartStorylineButton';
import { useIntroDismissed } from '~/hooks/useIntroDismissed';

export const STORYLINES_INTRO_DISMISSED_KEY = 'storylines-intro-dismissed';

const steps = [
  {
    icon: IconBook2,
    color: 'blue',
    title: 'Read',
    text: 'Every storyline is a run of posts. Start at chapter 1 and page through like one long post.',
  },
  {
    icon: IconGitFork,
    color: 'violet',
    title: 'Pick a path',
    text: 'At the end of a chapter, the story can fork. See where other readers went and choose yours.',
  },
  {
    icon: IconBrush,
    color: 'teal',
    title: 'Continue it',
    text: 'Add the next chapter from a post of your own. The creator reviews it before it joins.',
  },
] as const;

export function StorylinesIntro() {
  const [dismissed, dismiss] = useIntroDismissed(STORYLINES_INTRO_DISMISSED_KEY);
  if (dismissed) return null;

  return (
    <Card
      radius="lg"
      withBorder
      className="relative bg-gray-0 p-4 shadow-sm sm:p-6 dark:bg-dark-6"
      component="section"
      aria-labelledby="storylines-intro-title"
    >
      <CloseButton
        className="absolute right-2 top-2"
        aria-label="Dismiss the Storylines welcome"
        onClick={dismiss}
      />
      <Group gap={6} c="violet" fw={700} fz={13}>
        <IconRoute size={15} aria-hidden />
        New
      </Group>
      <Title order={2} id="storylines-intro-title" fz={{ base: 22, sm: 28 }} fw={800} mt={4} mb={6}>
        Welcome to Storylines
      </Title>
      <Text size="sm" c="dimmed" mb="lg">
        Stories told in images, one chapter at a time, by more than one creator. Read one from the
        start, or pick it up where it ends and write what happens next.
      </Text>

      {/* Compact rows on a phone, so the first storylines start on the first screen. */}
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-3 sm:gap-4">
        {steps.map(({ icon: Icon, color, title, text }) => (
          <div
            key={title}
            className="flex items-start gap-3 p-2 sm:rounded-md sm:border sm:border-solid sm:border-gray-3 sm:bg-gray-1 sm:p-4 sm:dark:border-dark-4 sm:dark:bg-dark-5"
          >
            <ThemeIcon variant="light" color={color} radius="xl" className="shrink-0">
              <Icon size={16} />
            </ThemeIcon>
            <div>
              <Text fw={700}>{title}</Text>
              <Text size="sm" c="dimmed">
                {text}
              </Text>
            </div>
          </div>
        ))}
      </div>

      <Group mt="lg" gap="sm" wrap="nowrap">
        <StartStorylineButton className="flex-1 sm:flex-none" />
        <Button variant="default" radius="xl" onClick={dismiss}>
          Got it
        </Button>
      </Group>
    </Card>
  );
}
