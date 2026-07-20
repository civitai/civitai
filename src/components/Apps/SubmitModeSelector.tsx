import { Card, SimpleGrid, Stack, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { IconExternalLink, IconTerminal2 } from '@tabler/icons-react';
import type { ReactNode } from 'react';

/**
 * /apps/submit type-picker (W13). The author first picks HOW to list their app:
 * an on-platform **App** (authored + submitted with the `civitai` CLI) or an
 * **External app** (a marketplace card that links the caller's OAuth app, with an
 * optional homepage link). Each type is a large selectable card; picking one calls
 * `onSelect`, and the page reveals that flow + a "choose a different type" affordance.
 *
 * Presentational only (no tRPC / no server imports) so it renders in isolation
 * for the component test.
 *
 * The internal mode id keeps the historical `block` value for the on-platform
 * app — only the label/copy is "App"; the code id is never renamed. The former
 * separate `'connect'` mode was MERGED into `'external'` (every external app IS an
 * OAuth app — one listing links the OAuth client + carries an optional homepage URL).
 */
export type SubmitMode = 'block' | 'external';

export function SubmitModeSelector({ onSelect }: { onSelect: (mode: SubmitMode) => void }) {
  return (
    <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md" data-testid="apps-submit-mode-selector">
      <ModeCard
        icon={<IconTerminal2 size={22} />}
        title="App"
        description="An on-platform app authored + submitted with the civitai CLI. The CLI scaffolds your block and submits it — a moderator reviews, then it deploys to your <slug>.civit.ai."
        onSelect={() => onSelect('block')}
        testId="apps-submit-mode-card-app"
      />
      <ModeCard
        icon={<IconExternalLink size={22} />}
        title="List an external app (connect your OAuth app)"
        description="List an app hosted off-site by linking your registered OAuth app so users can grant it access. Disclose the scopes your app requests and why, add an optional homepage link — a moderator reviews before it appears."
        onSelect={() => onSelect('external')}
        testId="apps-submit-mode-card-external"
      />
    </SimpleGrid>
  );
}

function ModeCard({
  icon,
  title,
  description,
  onSelect,
  testId,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onSelect: () => void;
  testId: string;
}) {
  return (
    <UnstyledButton onClick={onSelect} data-testid={testId} h="100%" style={{ height: '100%' }}>
      <Card withBorder p="lg" h="100%" className="hover:border-blue-5">
        <Stack gap="sm">
          <ThemeIcon size={44} radius="md" variant="light">
            {icon}
          </ThemeIcon>
          <Text fw={600} size="lg">
            {title}
          </Text>
          <Text size="sm" c="dimmed">
            {description}
          </Text>
        </Stack>
      </Card>
    </UnstyledButton>
  );
}
