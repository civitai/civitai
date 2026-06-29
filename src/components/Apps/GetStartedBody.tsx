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
import {
  APP_SDK_NPM_URL,
  BLOCKS_REACT_NPM_URL,
  CIVITAI_CLI_GITHUB_URL,
  CLI_CREATE_SAMPLE_COMMAND,
  CLI_INSTALL_BREW,
  CLI_INSTALL_GO,
  CLI_RUN_COMMAND,
  CLI_SUBMIT_COMMAND,
} from '~/components/Apps/cliCommands';
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

// CLI commands + ecosystem links are single-sourced in `./cliCommands` (shared
// with the submit CTA so the two surfaces can't drift). The quickstart uses the
// with-sample-name create form (`CLI_CREATE_SAMPLE_COMMAND`).

// Request-access intake = a PREFILLED new-issue on the public `civitai/cli`
// repo (the dev-native, zero-infra channel the page already links to). The
// title + body below are URL-encoded into the github.com/.../issues/new query
// so the issue opens pre-populated with a short intake prompt.
export const REQUEST_ACCESS_TITLE = 'App Blocks: request publishing access';
export const REQUEST_ACCESS_BODY = `Thanks for your interest in building on Civitai Apps!

- Civitai username:
- What you'd like to build:
- Links to anything you've built (repo/demo, optional):
`;
export const REQUEST_ACCESS_HREF = `https://github.com/civitai/cli/issues/new?title=${encodeURIComponent(
  REQUEST_ACCESS_TITLE
)}&body=${encodeURIComponent(REQUEST_ACCESS_BODY)}`;

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
          Build on Civitai&apos;s web + AI infrastructure — tap a catalog of hundreds of thousands of
          models and generate with Buzz. You focus on creating; we handle the rest.
        </Text>
      </Stack>

      {/* Quickstart — the whole point: copy 3 lines, you're running */}
      <Stack gap="sm">
        <Title order={2}>Quickstart</Title>
        <CopyableCommand command={CLI_INSTALL_BREW} />
        <Text size="xs" c="dimmed">
          or: <Code>{CLI_INSTALL_GO}</Code>
        </Text>
        <CopyableCommand command={CLI_CREATE_SAMPLE_COMMAND} />
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
            Build and test locally today; request access on GitHub to publish.
          </Text>
          <Group gap="xs">
            <Button
              component="a"
              href={REQUEST_ACCESS_HREF}
              target="_blank"
              rel="noopener noreferrer"
              leftSection={<IconLock size={16} />}
            >
              Request access on GitHub
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
