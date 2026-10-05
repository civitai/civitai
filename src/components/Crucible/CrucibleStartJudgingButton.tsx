import { Button } from '@mantine/core';
import { IconGavel } from '@tabler/icons-react';

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
