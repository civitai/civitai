import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Code,
  CopyButton,
  Divider,
  Group,
  List,
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
  IconCode,
  IconLock,
  IconMail,
  IconPackage,
  IconTerminal2,
} from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

/**
 * "App builders" get-started body — the Scope-A soft-launch funnel.
 *
 * The page that renders this is gated on the `appBlocksGetStarted` flag, which
 * is STAGED MOD-ONLY today (deploys dark-to-public; mods review live on prod)
 * and widened to `['public']` in a one-line flag change at launch — see
 * get-started.tsx / feature-flags.service.ts. This body is the copy that goes
 * live to everyone once the flag is widened.
 *
 * IMPORTANT (honesty / scope): this page explains the platform and points
 * would-be developers at the local build tooling. It does NOT open publishing.
 * Both `dev:live` (`/api/v1/blocks/dev-token`) and `civitai app submit`
 * (`/api/v1/blocks/submit-version`) are currently `isModerator`-gated server
 * side, so a non-mod can install the CLI, scaffold, and build/test LOCALLY
 * against the mock harness — but cannot publish yet. The copy frames publishing
 * as a PRIVATE BETA with a Request-access CTA. Do NOT change this framing to
 * imply a non-mod can publish today.
 *
 * COPY IS A FIRST DRAFT for Zach's review/voice. Keep claims accurate; do not
 * add features, metrics, dates, or links beyond the verified ones below.
 *
 * Pure presentational (props-only, no tRPC / no network) so it renders in
 * isolation in component tests — mirrors MarketplaceBody being extracted out of
 * the page's server-side import chain.
 */

// --- Real, verified external links / commands (single source for tests) ---
export const CIVITAI_CLI_GITHUB_URL = 'https://github.com/civitai/cli';
export const BLOCKS_REACT_NPM_URL = 'https://www.npmjs.com/package/@civitai/blocks-react';
export const APP_SDK_NPM_URL = 'https://www.npmjs.com/package/@civitai/app-sdk';

export const CLI_INSTALL_BREW = 'brew install civitai/tap/civitai';
export const CLI_INSTALL_GO = 'go install github.com/civitai/cli/cmd/civitai@latest';
export const CLI_CREATE_COMMAND = 'civitai app create';
export const CLI_DEV_HARNESS_COMMAND = 'npm run dev:harness';
export const CLI_SUBMIT_COMMAND = 'civitai app submit';
export const SDK_INSTALL_COMMAND = 'npm install @civitai/blocks-react @civitai/app-sdk';

// TODO: real request-access link — replace this placeholder with the live
// request-access form (or a mailto:) once it exists. Left as `#` so it is an
// obvious, non-functional placeholder for Zach to fill in before launch.
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

function ExternalAnchor({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Anchor href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </Anchor>
  );
}

export function GetStartedBody() {
  return (
    <Stack gap="xl">
      {/* ---------------------------------------------------------------- */}
      {/* Hero — what are Civitai Apps */}
      {/* ---------------------------------------------------------------- */}
      <Stack gap="sm">
        <Group gap="xs">
          <ThemeIcon size="lg" radius="md" variant="light" color="blue">
            <IconCode size={22} />
          </ThemeIcon>
          <Badge color="blue" variant="light" radius="sm">
            For app builders
          </Badge>
        </Group>
        <Title order={1}>Build apps on Civitai</Title>
        <Text size="lg" c="dimmed">
          Civitai Apps are small web apps that run inside civitai.com. They can render in a slot on a
          model page, or as a full page at <Code>{'<slug>'}.civit.ai</Code> (also reachable at{' '}
          <Code>civitai.com/apps/run/{'<slug>'}</Code>). An app can read catalog data and — with a
          budget — run generations.
        </Text>
        <Alert color="blue" variant="light" icon={<IconLock size={18} />}>
          <Text size="sm" fw={600}>
            Publishing is in private beta.
          </Text>
          <Text size="sm">
            Anyone can install the tools, scaffold an app, and build + test it locally against the
            mock harness today. Publishing an app to civitai.com is gated to approved builders while
            we finish the moderator-review flow. Want in?{' '}
            <Anchor href={REQUEST_ACCESS_HREF}>Request access</Anchor>.
          </Text>
        </Alert>
      </Stack>

      <Divider />

      {/* ---------------------------------------------------------------- */}
      {/* The tools */}
      {/* ---------------------------------------------------------------- */}
      <Stack gap="md">
        <Title order={2}>The tools</Title>
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          {/* CLI */}
          <Card withBorder radius="md" p="lg">
            <Stack gap="md">
              <Group gap="xs">
                <ThemeIcon size="md" radius="md" variant="light" color="blue">
                  <IconTerminal2 size={18} />
                </ThemeIcon>
                <Title order={3} m={0}>
                  The <Code>civitai</Code> CLI
                </Title>
              </Group>
              <Text size="sm" c="dimmed">
                Scaffolds an app, runs it locally, and (for approved builders) packages and submits
                it for review.
              </Text>
              <Stack gap={6}>
                <Text size="sm" fw={600}>
                  Install (Homebrew)
                </Text>
                <CopyableCommand command={CLI_INSTALL_BREW} />
                <Text size="sm" fw={600} mt={4}>
                  …or with Go
                </Text>
                <CopyableCommand command={CLI_INSTALL_GO} />
              </Stack>
              <Button
                component="a"
                href={CIVITAI_CLI_GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                variant="light"
                leftSection={<IconBrandGithub size={16} />}
              >
                Get the Civitai CLI
              </Button>
            </Stack>
          </Card>

          {/* SDK */}
          <Card withBorder radius="md" p="lg">
            <Stack gap="md">
              <Group gap="xs">
                <ThemeIcon size="md" radius="md" variant="light" color="grape">
                  <IconPackage size={18} />
                </ThemeIcon>
                <Title order={3} m={0}>
                  The runtime SDK
                </Title>
              </Group>
              <Text size="sm" c="dimmed">
                Build your app UI with <Code>@civitai/blocks-react</Code> and talk to the host with{' '}
                <Code>@civitai/app-sdk</Code>.
              </Text>
              <Stack gap={6}>
                <Text size="sm" fw={600}>
                  Install (npm)
                </Text>
                <CopyableCommand command={SDK_INSTALL_COMMAND} />
              </Stack>
              <Group gap="xs">
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
          </Card>
        </SimpleGrid>
      </Stack>

      <Divider />

      {/* ---------------------------------------------------------------- */}
      {/* The process */}
      {/* ---------------------------------------------------------------- */}
      <Stack gap="md">
        <Title order={2}>The process</Title>

        <Stack gap={6}>
          <Text size="sm" fw={600}>
            1. Scaffold a new app (page-money template)
          </Text>
          <CopyableCommand command={CLI_CREATE_COMMAND} />
        </Stack>

        <Stack gap={6}>
          <Text size="sm" fw={600}>
            2. Build + test locally against the mock harness
          </Text>
          <CopyableCommand command={CLI_DEV_HARNESS_COMMAND} />
          <Text size="xs" c="dimmed">
            The harness mocks the Civitai host so you can develop the whole app — catalog reads, the
            generation flow, budgets — without any access to production.
          </Text>
        </Stack>

        {/* Gated / private-beta step — visually distinct */}
        <Card withBorder radius="md" p="lg" style={{ borderStyle: 'dashed' }}>
          <Stack gap="sm">
            <Group gap="xs">
              <ThemeIcon size="md" radius="md" variant="light" color="yellow">
                <IconLock size={16} />
              </ThemeIcon>
              <Text size="sm" fw={700}>
                3. Publish — private beta
              </Text>
              <Badge color="yellow" variant="light" radius="sm" size="sm">
                Approved builders only
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              Once you have access, <Code>civitai app submit</Code> packages your source and sends it
              to moderator review. After approval your app goes live at <Code>{'<slug>'}.civit.ai</Code>.
            </Text>
            <CopyableCommand command={CLI_SUBMIT_COMMAND} />
            <Text size="xs" c="dimmed">
              This step is gated today — see &ldquo;Request access&rdquo; below.
            </Text>
          </Stack>
        </Card>
      </Stack>

      <Divider />

      {/* ---------------------------------------------------------------- */}
      {/* Today vs coming + Request access CTA */}
      {/* ---------------------------------------------------------------- */}
      <Card withBorder radius="md" p="lg">
        <Stack gap="md">
          <Title order={2} m={0}>
            What you can do today
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
            <Stack gap={6}>
              <Text size="sm" fw={600}>
                Available now
              </Text>
              <List
                size="sm"
                spacing={4}
                icon={
                  <ThemeIcon color="green" size={18} radius="xl" variant="light">
                    <IconCheck size={12} />
                  </ThemeIcon>
                }
              >
                <List.Item>Install the CLI and the runtime SDK.</List.Item>
                <List.Item>Scaffold and build an app locally.</List.Item>
                <List.Item>Test against the mock harness end to end.</List.Item>
              </List>
            </Stack>
            <Stack gap={6}>
              <Text size="sm" fw={600}>
                Coming (private beta)
              </Text>
              <List
                size="sm"
                spacing={4}
                icon={
                  <ThemeIcon color="yellow" size={18} radius="xl" variant="light">
                    <IconLock size={12} />
                  </ThemeIcon>
                }
              >
                <List.Item>Publish an app to civitai.com.</List.Item>
                <List.Item>Moderator review + going live at your slug.</List.Item>
                <List.Item>Running real generations against a budget.</List.Item>
              </List>
            </Stack>
          </SimpleGrid>

          <Divider />

          <Group justify="space-between" align="center" wrap="wrap">
            <Text size="sm" c="dimmed" style={{ maxWidth: 460 }}>
              Want to publish? Request access and we&apos;ll reach out as we open up the private
              beta.
            </Text>
            <Button
              component="a"
              href={REQUEST_ACCESS_HREF}
              leftSection={<IconMail size={16} />}
            >
              Request publishing access
            </Button>
          </Group>
        </Stack>
      </Card>

      <Text size="xs" c="dimmed">
        Source &amp; docs:{' '}
        <ExternalAnchor href={CIVITAI_CLI_GITHUB_URL}>github.com/civitai/cli</ExternalAnchor>
        {' · '}
        <ExternalAnchor href={BLOCKS_REACT_NPM_URL}>blocks-react on npm</ExternalAnchor>
        {' · '}
        <ExternalAnchor href={APP_SDK_NPM_URL}>app-sdk on npm</ExternalAnchor>
      </Text>
    </Stack>
  );
}
