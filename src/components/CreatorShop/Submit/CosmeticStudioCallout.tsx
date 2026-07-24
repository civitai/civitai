import { Button, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconArrowRight, IconSparkles } from '@tabler/icons-react';
import { COSMETIC_STUDIO_URL } from '~/components/CreatorShop/creator-shop.constants';
import { useSpotlight } from '~/hooks/useSpotlight';

// Nudge toward the standalone Cosmetic Studio for creators who don't have
// artwork ready yet. Shown above the artwork dropzone on new submissions.
// Cursor-following spotlight matches the crypto deposit / prize pool cards.
export function CosmeticStudioCallout() {
  const { spotlightRef, handleMouseMove, handleMouseLeave } = useSpotlight({
    size: 300,
    color: 'light-dark(rgba(190,75,219,0.08), rgba(218,127,255,0.1))',
  });

  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="relative overflow-hidden"
      style={{
        borderColor: 'var(--mantine-color-grape-outline)',
        background:
          'linear-gradient(135deg, var(--mantine-color-grape-light), var(--mantine-color-violet-light))',
      }}
    >
      <div
        ref={spotlightRef}
        className="pointer-events-none absolute inset-0 transition-opacity duration-500"
        style={{ opacity: 0 }}
      />
      <Group wrap="nowrap" gap="sm" align="center" className="relative">
        <ThemeIcon variant="light" color="grape" size="lg" radius="md">
          <IconSparkles size={20} />
        </ThemeIcon>
        <Stack gap={2} style={{ flex: 1 }}>
          <Text size="sm" fw={600}>
            Don&apos;t have cosmetic artwork yet?
          </Text>
          <Text size="xs" c="dimmed">
            Design one that meets the standards in the Cosmetic Studio, then upload it here.
          </Text>
        </Stack>
        <Button
          component="a"
          href={COSMETIC_STUDIO_URL}
          target="_blank"
          rel="noopener noreferrer"
          variant="light"
          color="grape"
          size="xs"
          rightSection={<IconArrowRight size={14} />}
        >
          Open Cosmetic Studio
        </Button>
      </Group>
    </Paper>
  );
}
