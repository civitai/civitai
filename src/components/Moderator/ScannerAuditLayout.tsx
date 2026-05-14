/**
 * Shared chrome for the /moderator/scanner-audit pages.
 * Mode tabs (Text / Prompt / Media) drive URL routing.
 */
import { Container, Group, Stack, Tabs, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import type { Scanner } from '~/server/schema/scanner-review.schema';

const MODES = [
  { value: 'text', label: 'Text' },
  { value: 'prompt', label: 'Prompt' },
  { value: 'media', label: 'Media' },
] as const;

export type ScannerAuditMode = (typeof MODES)[number]['value'];

export function modeToScanner(mode: ScannerAuditMode): Scanner {
  switch (mode) {
    case 'text':
      return 'xguard_text';
    case 'prompt':
      return 'xguard_prompt';
    case 'media':
      return 'image_ingestion';
  }
}

export function isValidMode(s: string | undefined): s is ScannerAuditMode {
  return s === 'text' || s === 'prompt' || s === 'media';
}

export function ScannerAuditLayout({
  activeMode,
  rightAction,
  children,
}: {
  activeMode: ScannerAuditMode;
  rightAction?: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();

  return (
    <Container size="xl" py="lg">
      <Stack gap="md">
        <Group justify="space-between">
          <Title order={2}>Scanner Audit</Title>
          {rightAction}
        </Group>
        <Tabs
          value={activeMode}
          onChange={(value) => {
            if (value) router.push(`/moderator/scanner-audit/${value}`);
          }}
        >
          <Tabs.List>
            {MODES.map((m) => (
              <Tabs.Tab key={m.value} value={m.value}>
                {m.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
        {children}
      </Stack>
    </Container>
  );
}
