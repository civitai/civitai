import { Button, Card, CloseButton, Group, Text, ThemeIcon, Title } from '@mantine/core';
import { IconBook2, IconBrush, IconGitFork, IconPlus, IconRoute } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
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

/** Shown at the top of the storylines section to everyone until they dismiss it. */
export function StorylinesIntro() {
  const currentUser = useCurrentUser();
  const [dismissed, dismiss] = useIntroDismissed(STORYLINES_INTRO_DISMISSED_KEY);
  if (dismissed) return null;

  const startProps = {
    color: 'violet',
    radius: 'xl',
    leftSection: <IconPlus size={16} />,
    children: 'Start a storyline',
  } as const;

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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {steps.map(({ icon: Icon, color, title, text }) => (
          <Card
            key={title}
            radius="md"
            p="md"
            withBorder
            className="border-gray-3 bg-gray-1 dark:border-dark-4 dark:bg-dark-5"
          >
            <Group gap="xs" mb="xs">
              <ThemeIcon variant="light" color={color} radius="xl">
                <Icon size={16} />
              </ThemeIcon>
              <Text fw={700}>{title}</Text>
            </Group>
            <Text size="sm" c="dimmed">
              {text}
            </Text>
          </Card>
        ))}
      </div>

      <Group mt="lg" gap="sm" className="flex-col items-stretch sm:flex-row sm:items-center">
        {currentUser?.username ? (
          // A storyline starts from a post's menu, so this goes to the viewer's own posts.
          <Button component={Link} href={`/user/${currentUser.username}/posts`} {...startProps} />
        ) : (
          <LoginRedirect reason="perform-action">
            <Button {...startProps} />
          </LoginRedirect>
        )}
        <Button variant="default" radius="xl" onClick={dismiss}>
          Got it
        </Button>
      </Group>
      <Text size="xs" c="dimmed" mt="xs">
        Start a storyline opens your posts; any post you made can become chapter 1.
      </Text>
    </Card>
  );
}
