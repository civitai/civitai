import {
  Badge,
  Box,
  Button,
  Card,
  Code,
  CopyButton,
  Divider,
  Group,
  List,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconBrandGithub, IconCheck, IconClipboard, IconLock } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

/**
 * "App builders" get-started body — the Scope-A soft-launch funnel.
 *
 * The page that renders this is gated on the `appBlocksGetStarted` flag, which
 * is STAGED MOD-ONLY today (deploys dark-to-public; mods review live on prod)
 * and widened to `['public']` in a one-line flag change at launch — see
 * get-started.tsx / feature-flags.service.ts.
 *
 * Copy is QUICKSTART-FIRST (devs scan + copy-paste; minimal prose). Honesty /
 * scope: this page points would-be developers at the LOCAL build tooling — it
 * does NOT open publishing. Both `dev:live` (`/api/v1/blocks/dev-token`) and
 * `civitai app submit` (`/api/v1/blocks/submit-version`) are `isModerator`-gated
 * server side, so a non-mod can install the CLI, scaffold, and build/test
 * locally against the mock harness — but cannot publish yet. The copy frames
 * publishing as a PRIVATE BETA with a Request-access CTA. Do NOT change that
 * framing to imply a non-mod can publish today.
 *
 * Pure presentational (props-only, no tRPC / no network) so it renders in
 * isolation in component tests.
 */

// --- Real, verified external links / commands (single source for tests) ---
export const CIVITAI_CLI_GITHUB_URL = 'https://github.com/civitai/cli';
export const BLOCKS_REACT_NPM_URL = 'https://www.npmjs.com/package/@civitai/blocks-react';
export const APP_SDK_NPM_URL = 'https://www.npmjs.com/package/@civitai/app-sdk';

export const CLI_INSTALL_BREW = 'brew install civitai/tap/civitai';
export const CLI_INSTALL_GO = 'go install github.com/civitai/cli/cmd/civitai@latest';
export const CLI_CREATE_COMMAND = 'civitai app create my-app';
// The CLI does NOT install deps on `create`; its own next-step prompt is
// `cd <dir> && npm install && npm run dev:harness`. `dev:harness` serves a MOCK
// host at localhost:5186 (plain `npm run dev` shows a blank screen — no host).
export const CLI_RUN_COMMAND = 'cd my-app && npm install && npm run dev:harness';
export const CLI_SUBMIT_COMMAND = 'civitai app submit';

// TODO: real request-access link — replace this placeholder with the live
// request-access form (or a mailto:) before launch. Left as `#` so it is an
// obvious, non-functional placeholder.
export const REQUEST_ACCESS_HREF = '#';

function CopyableCommand({ command }: { command: string }) {
  return (
    <CopyButton value={command}>
      {({ copied, copy }) => (
        <Box pos="relative" onClick={copy} style={{ cursor: 'pointer' }}>
          <Code
            block
            color={copied ? 'green' : undefined}
            style={{ wordBreak: 'break-all', paddingRight: 36 }}
          >
            {copied ? 'Copied' : `$ ${command}`}
          </Code>
          <LegacyActionIcon
            className="absolute right-2 top-1/2 -translate-y-1/2"
            right={8}
            variant="transparent"
            color="gray"
            aria-label={`Copy command: ${command}`}
            onClick={copy}
          >
            {copied ? <IconCheck size={16} /> : <IconClipboard size={16} />}
          </LegacyActionIcon>
        </Box>
      )}
    </CopyButton>
  );
}

export function GetStartedBody() {
  return (
    <Stack gap="xl">
      {/* Hero — one line, no wall of text */}
      <Stack gap="xs">
        <Group gap="xs">
          <Badge color="blue" variant="light" radius="sm">
            For app builders
          </Badge>
        </Group>
        <Title order={1}>Build apps on Civitai</Title>
        <Text size="lg" c="dimmed">
          Small web apps that run inside Civitai — read models &amp; images, generate with Buzz, and
          ship to your own page at <Code>yourapp.civit.ai</Code>.
        </Text>
      </Stack>

      {/* Quickstart — the whole point: copy 3 lines, you're running */}
      <Stack gap="sm">
        <Title order={2}>Quickstart</Title>
        <CopyableCommand command={CLI_INSTALL_BREW} />
        <Text size="xs" c="dimmed">
          or: <Code>{CLI_INSTALL_GO}</Code>
        </Text>
        <CopyableCommand command={CLI_CREATE_COMMAND} />
        <CopyableCommand command={CLI_RUN_COMMAND} />
        <Text size="sm" c="dimmed">
          Opens at <Code>localhost:5186</Code> in a mock Civitai — no account, no Buzz needed. Edit{' '}
          <Code>src/App.tsx</Code> and go.
        </Text>
      </Stack>

      <Divider />

      {/* What you get — 3 lines + the links */}
      <Stack gap="sm">
        <Title order={2}>What you get</Title>
        <List
          size="sm"
          spacing={6}
          icon={
            <ThemeIcon color="blue" size={18} radius="xl" variant="light">
              <IconCheck size={12} />
            </ThemeIcon>
          }
        >
          <List.Item>
            <Code>civitai</Code> CLI — scaffold, run, and submit your app.
          </List.Item>
          <List.Item>
            <Code>@civitai/blocks-react</Code> — UI components, auto-themed to Civitai.
          </List.Item>
          <List.Item>
            <Code>@civitai/app-sdk</Code> — pick models, run generations, store data.
          </List.Item>
        </List>
        <Text size="xs" c="dimmed">
          Both SDK packages ship in the scaffold.
        </Text>
        <Group gap="xs">
          <Button
            component="a"
            href={CIVITAI_CLI_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="light"
            size="xs"
            leftSection={<IconBrandGithub size={16} />}
          >
            Civitai CLI
          </Button>
          <Button
            component="a"
            href={BLOCKS_REACT_NPM_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="light"
            color="grape"
            size="xs"
          >
            @civitai/blocks-react
          </Button>
          <Button
            component="a"
            href={APP_SDK_NPM_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="light"
            color="grape"
            size="xs"
          >
            @civitai/app-sdk
          </Button>
        </Group>
      </Stack>

      <Divider />

      {/* Publish — one command + one line + the private-beta tag */}
      <Card withBorder radius="md" p="lg" style={{ borderStyle: 'dashed' }}>
        <Stack gap="sm">
          <Group gap="xs">
            <ThemeIcon size="md" radius="md" variant="light" color="yellow">
              <IconLock size={16} />
            </ThemeIcon>
            <Title order={2} m={0}>
              Publish
            </Title>
            <Badge color="yellow" variant="light" radius="sm" size="sm">
              private beta
            </Badge>
          </Group>
          <CopyableCommand command={CLI_SUBMIT_COMMAND} />
          <Text size="sm" c="dimmed">
            Sends your app for a quick review → live at <Code>yourapp.civit.ai</Code>.
          </Text>
          <Text size="sm" fw={600}>
            Publishing is in private beta.
          </Text>
          <Text size="sm" c="dimmed">
            Build and test locally today; request access to publish.
          </Text>
          <Group gap="xs">
            <Button
              component="a"
              href={REQUEST_ACCESS_HREF}
              leftSection={<IconLock size={16} />}
            >
              Request access
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
