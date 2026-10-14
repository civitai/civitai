import { Badge, Button, Card, Group, Text, ThemeIcon, Title } from '@mantine/core';
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
    <Card radius="md" withBorder p="xl" className="bg-gray-0 dark:bg-dark-6">
      <Badge
        variant="light"
        color="violet"
        leftSection={<IconRoute size={12} />}
        mb="xs"
        className="self-start"
      >
        New
      </Badge>
      <Title order={2} mb={4}>
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
            className="border-gray-3 bg-white dark:border-dark-4 dark:bg-dark-5"
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

      <Group mt="lg" gap="sm">
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
    </Card>
  );
}
