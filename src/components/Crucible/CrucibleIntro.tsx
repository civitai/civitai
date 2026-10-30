import { Button, Card, Group, Text, ThemeIcon, Title } from '@mantine/core';
import { IconGavel, IconTrophy, IconUpload } from '@tabler/icons-react';
import Link from 'next/link';

const steps = [
  {
    icon: IconUpload,
    color: 'blue',
    title: 'Enter',
    text: 'Submit your best image or video to a crucible whose theme it fits. Every entry fee grows the prize pool.',
  },
  {
    icon: IconGavel,
    color: 'green',
    title: 'Judge',
    text: "Pick the better of two entries, head to head. Every vote moves the rankings, and every judge's vote counts the same.",
  },
  {
    icon: IconTrophy,
    color: 'yellow',
    title: 'Win',
    text: 'When the timer runs out, the top-ranked entries split the prize pool in Buzz.',
  },
] as const;

export function CrucibleIntro({
  canCreate,
  onDismiss,
}: {
  canCreate: boolean;
  onDismiss: () => void;
}) {
  return (
    <Card
      radius="md"
      className="mb-8 border border-[#373a40]"
      style={{ background: 'linear-gradient(135deg, #25262b 0%, #1a1b1e 100%)' }}
      p="xl"
    >
      <Title order={2} c="white" mb={4}>
        Welcome to the Crucible
      </Title>
      <Text size="sm" c="dimmed" mb="lg">
        A new way to play and earn Buzz on Civitai: head-to-head competitions where the community,
        not an AI, picks the winner.
      </Text>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {steps.map(({ icon: Icon, color, title, text }) => (
          <Card
            key={title}
            radius="md"
            p="md"
            className="border border-[#373a40]"
            style={{ background: 'rgba(37, 38, 43, 0.5)' }}
          >
            <Group gap="xs" mb="xs">
              <ThemeIcon variant="light" color={color} radius="xl">
                <Icon size={16} />
              </ThemeIcon>
              <Text fw={700} c="white">
                {title}
              </Text>
            </Group>
            <Text size="sm" c="dimmed">
              {text}
            </Text>
          </Card>
        ))}
      </div>

      <Group mt="lg" gap="sm">
        {canCreate && (
          <Button component={Link} href="/crucibles/create" radius="xl">
            Create a crucible
          </Button>
        )}
        <Button variant="default" radius="xl" onClick={onDismiss}>
          Got it
        </Button>
      </Group>
    </Card>
  );
}
