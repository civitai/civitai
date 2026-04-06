import { useCallback, useRef } from 'react';
import { Button, Divider, Loader, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconChartBar, IconRocket } from '@tabler/icons-react';
import Link from 'next/link';

export type EmptyStateProps = {
  /** The color associated with the current buzz type (e.g. yellow hex) */
  buzzColor: string;
  /** Label like "Yellow" or "Green" */
  buzzLabel: string;
  /** Show loading state instead of empty state */
  loading?: boolean;
};

export function GenerationBuzzEmptyState({ buzzColor, loading }: EmptyStateProps) {
  // Spotlight effect — uses refs + direct DOM manipulation to avoid re-renders on mouse move
  const spotlightRef = useRef<HTMLDivElement>(null);
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = spotlightRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.background = `radial-gradient(400px circle at ${x}px ${y}px, light-dark(rgba(0,0,0,0.02), rgba(255,255,255,0.04)), transparent 70%)`;
    el.style.opacity = '1';
  }, []);
  const handleMouseLeave = useCallback(() => {
    const el = spotlightRef.current;
    if (el) el.style.opacity = '0';
  }, []);

  return (
    <div className="mt-2">
      {/* Full-width divider under the header */}
      <Divider />

      {/* Split layout */}
      <div className="grid grid-cols-1 sm:grid-cols-2">
        {/* Left — info panel */}
        <Stack gap="sm" p="lg" justify="center" align="center">
          {loading ? (
            <Loader size={32} />
          ) : (
            <ThemeIcon size={48} variant="light" color="gray" radius="xl">
              <IconChartBar size={24} />
            </ThemeIcon>
          )}
          <Text fw={700} size="lg" ta="center">
            {loading ? 'Loading data...' : "You haven't earned anything yet"}
          </Text>
          {!loading && (
            <>
              <Text size="sm" c="dimmed" ta="center" maw={320}>
                This is where you&apos;ll see Buzz earned when other users generate images with your
                published models.
              </Text>
              <Text size="xs" c="dimmed" ta="center">
                Earnings can take up to 24 hours to appear
              </Text>
            </>
          )}
        </Stack>

        {/* Right — CTA panel with gradient background + accent border + spotlight */}
        <div
          className="relative overflow-hidden border-t border-gray-200 dark:border-white/5 sm:border-t-0 sm:border-l bg-gradient-to-br from-blue-500/5 to-yellow-500/5 dark:from-blue-500/[0.06] dark:to-yellow-500/[0.06]"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {/* Spotlight glow */}
          <div
            ref={spotlightRef}
            className="absolute inset-0 pointer-events-none transition-opacity duration-500"
            style={{ opacity: 0 }}
          />

          {/* Accent border strip */}
          <div className="absolute left-0 top-[10%] bottom-[10%] w-[3px] rounded-sm bg-gradient-to-b from-blue-500 to-yellow-500 hidden sm:block" />

          <Stack gap="md" p="lg" pl="xl" justify="center" className="relative z-[1] h-full">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.08em' }}>
                Start earning
              </Text>
              <Text fw={600}>
                Train &amp; publish models to earn Buzz
              </Text>
            </Stack>

            <Stack gap={10}>
              <StepRow number={1} text="Train a custom model (LoRA, checkpoint, etc.)" buzzColor={buzzColor} />
              <StepRow number={2} text="Publish it on Civitai for the community" buzzColor={buzzColor} />
              <StepRow number={3} text="Earn Buzz every time someone generates with it" buzzColor={buzzColor} />
            </Stack>

            <Button
              component={Link}
              href="/models/train"
              variant="filled"
              size="sm"
              leftSection={<IconRocket size={16} />}
              className="w-fit"
            >
              Train a model
            </Button>
          </Stack>
        </div>
      </div>
    </div>
  );
}

function StepRow({ number, text, buzzColor }: { number: number; text: string; buzzColor: string }) {
  return (
    <div className="flex items-start gap-2">
      <div
        className="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
        style={{ backgroundColor: buzzColor }}
      >
        {number}
      </div>
      <Text size="xs" c="dimmed">
        {text}
      </Text>
    </div>
  );
}
