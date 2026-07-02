import {
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  CopyButton,
  Divider,
  Group,
  Image,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconBrandGithub,
  IconCheck,
  IconClipboard,
  IconDatabase,
  IconPalette,
  IconPhoto,
  IconServer,
  IconSparkles,
  IconUser,
} from '@tabler/icons-react';
import {
  APP_SDK_NPM_URL,
  BLOCKS_REACT_NPM_URL,
  CIVITAI_CLI_GITHUB_URL,
  CLI_CREATE_SAMPLE_COMMAND,
  CLI_INSTALL_BREW,
  CLI_INSTALL_GO,
  CLI_RUN_COMMAND,
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
 * scope: this page points would-be developers at the LOCAL build tooling. The
 * `dev:live` (`/api/v1/blocks/dev-token`) path is `isModerator`-gated server
 * side, so a non-mod can install the CLI, scaffold, and build/test locally
 * against the mock harness.
 *
 * Pure presentational (props-only, no tRPC / no network) so it renders in
 * isolation in component tests.
 */

// CLI commands + ecosystem links are single-sourced in `./cliCommands`. The
// quickstart uses the with-sample-name create form (`CLI_CREATE_SAMPLE_COMMAND`).

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
      {/* Banner — 3:2 hero image (public asset, no layout shift) */}
      <Image
        src="/images/apps/civitai-apps-banner.webp"
        alt="Build apps on Civitai"
        radius="md"
        w="100%"
        style={{ aspectRatio: '3 / 2' }}
      />

      {/* Hero — one line, no wall of text */}
      <Stack gap="xs">
        <Group gap="xs">
          <Badge color="blue" variant="light" radius="sm">
            Beta
          </Badge>
        </Group>
        <Title order={1}>Build on Civitai</Title>
        <Text size="lg" c="dimmed">
          Build on Civitai&apos;s web + AI infrastructure. Tap a catalog of hundreds of thousands of
          models and generate with Buzz. You focus on creating; we handle the rest.
        </Text>
      </Stack>

      {/* Quickstart — the whole point: copy 3 lines, you're running */}
      <Stack gap="sm">
        <Title order={2}>Quickstart</Title>
        <Text size="sm" c="dimmed">
          Create a local Civitai app in 3 steps with the{' '}
          <Anchor href={CIVITAI_CLI_GITHUB_URL} target="_blank" rel="noopener noreferrer">
            Civitai CLI
          </Anchor>
        </Text>
        <CopyableCommand command={CLI_INSTALL_BREW} />
        <Text size="xs" c="dimmed">
          or: <Code>{CLI_INSTALL_GO}</Code>
        </Text>
        <CopyableCommand command={CLI_CREATE_SAMPLE_COMMAND} />
        <CopyableCommand command={CLI_RUN_COMMAND} />
      </Stack>

      <Divider />

      {/* What you get — the platform leverage a dev gets, then the toolkit links */}
      <Stack gap="sm">
        <Title order={2}>What you get</Title>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <ThemeIcon size="md" radius="md" variant="light" color="blue">
              <IconPhoto size={16} />
            </ThemeIcon>
            <Text size="sm">
              <b>A huge model catalog</b>: search hundreds of thousands of models &amp; images from
              your app.
            </Text>
          </Group>
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <ThemeIcon size="md" radius="md" variant="light" color="grape">
              <IconSparkles size={16} />
            </ThemeIcon>
            <Text size="sm">
              <b>AI generation, no GPUs</b>: run generations on Civitai&apos;s infrastructure, paid
              in Buzz.
            </Text>
          </Group>
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <ThemeIcon size="md" radius="md" variant="light" color="teal">
              <IconServer size={16} />
            </ThemeIcon>
            <Text size="sm">
              <b>Hosting handled</b>: we build and host your app; no Docker, no servers.
            </Text>
          </Group>
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <ThemeIcon size="md" radius="md" variant="light" color="blue">
              <IconUser size={16} />
            </ThemeIcon>
            <Text size="sm">
              <b>Built-in identity</b>: your app knows who&apos;s viewing; no auth to wire up.
            </Text>
          </Group>
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <ThemeIcon size="md" radius="md" variant="light" color="grape">
              <IconDatabase size={16} />
            </ThemeIcon>
            <Text size="sm">
              <b>Private storage</b>: a per-app key-value store for your data.
            </Text>
          </Group>
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <ThemeIcon size="md" radius="md" variant="light" color="teal">
              <IconPalette size={16} />
            </ThemeIcon>
            <Text size="sm">
              <b>Themed UI kit</b>: drop-in components that match Civitai automatically.
            </Text>
          </Group>
        </SimpleGrid>

        <Text size="xs" fw={600} c="dimmed" mt="xs">
          Your toolkit
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
    </Stack>
  );
}
