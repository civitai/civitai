import { Stack, Text, ThemeIcon } from '@mantine/core';
import { IconClock } from '@tabler/icons-react';
import { useVotingCooldown } from '~/components/Games/KnightsNewOrder.utils';

const formatCooldown = (seconds: number) => {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm.toString().padStart(2, '0')}m`;
};

export function NewOrderCooldownLockout() {
  const { secondsRemaining } = useVotingCooldown();

  return (
    <div className="flex h-full min-h-[400px] w-full items-center justify-center p-8">
      <Stack align="center" gap="md" className="max-w-md text-center">
        <ThemeIcon size={96} radius={999} color="yellow" variant="light">
          <IconClock size={48} />
        </ThemeIcon>
        <Text size="xl" fw={600}>
          Voting cooldown
        </Text>
        <Text size="md" c="dimmed">
          You&apos;ve been rating quickly enough to trip the rate limit. Take a short break — your
          queue is waiting.
        </Text>
        <Text size="xl" fw={700} className="font-mono">
          {formatCooldown(secondsRemaining)}
        </Text>
        <Text size="sm" c="dimmed">
          Voting will resume automatically.
        </Text>
      </Stack>
    </div>
  );
}
