import { Button, Group, Paper, Text } from '@mantine/core';
import { IconCircleCheck, IconGavel } from '@tabler/icons-react';

export function CrucibleStartJudgingButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      size="xl"
      fullWidth
      leftSection={<IconGavel size={24} />}
      className="mb-8"
      styles={{
        root: {
          background: 'linear-gradient(135deg, #228be6 0%, #40c057 100%)',
          boxShadow: '0 8px 24px rgba(34, 139, 230, 0.3)',
          fontWeight: 600,
          fontSize: '1.125rem',
          // Inline only: size="xl" fixes the height, so vertical padding squeezes the label and
          // clips descenders.
          paddingInline: '2.5rem',
        },
      }}
      onClick={onClick}
    >
      Start Judging Now
    </Button>
  );
}

export function CrucibleCaughtUpNotice() {
  return (
    <Paper className="mb-8 rounded-xl border border-[#373a40] text-center" bg="dark.6" p="lg">
      <Group justify="center" gap="xs">
        <IconCircleCheck size={22} className="text-green-400" />
        <Text fw={600} size="lg">
          You&apos;re caught up
        </Text>
      </Group>
      <Text c="dimmed" size="sm" mt={4}>
        You&apos;ve judged everything open to you here. New entries open new pairs until the
        crucible ends.
      </Text>
    </Paper>
  );
}
