import {
  Anchor,
  Badge,
  Button,
  Code,
  Collapse,
  Divider,
  Group,
  Image,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconBrandGithub,
  IconChevronDown,
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
import { AgentOnboardingCard } from '~/components/Apps/AgentOnboardingCard';
import { CopyableCommand } from '~/components/Apps/CopyableCommand';

/**
 * "App builders" get-started body — the Scope-A soft-launch funnel.
 *
 * This is not a page and is not gated on its own. It is mounted by `AppsBuildBody`
 * as state A of `/apps/build`, whose gate is `canAccessAppsBuild` =
 * `hasAppsStoreAccess(features) && (isAppDeveloper(user, …) || appBlocksGetStarted)`
 * (`~/shared/utils/app-blocks-access`). `appBlocksGetStarted` is STAGED MOD-ONLY today,
 * but it is one disjunct UNDER a store AND, not the gate — so widening it alone is NOT
 * a one-line flag change and does not launch this: the widened cohort gets a `notFound`
 * from `/apps/build`. See the flag's own comment in `feature-flags.service.ts` for what
 * else has to move. (The earlier version of this note said "one-line flag change" and
 * pointed at `/apps/get-started`, a page this consolidation deletes.)
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

/**
 * `onCopyCommand` is OPTIONAL and threads the `/apps/build` funnel's `cli_copy` step
 * out to whoever mounted this. It is a CALLBACK rather than a `useTrackEvent()` call
 * in here on purpose: the header above promises this component is props-only with no
 * network, and its `*.browser.test.tsx` suite mounts it with no providers — importing
 * the tracker would break both. See `AppsBuildBody`, the one call site that passes it.
 *
 * `onCopyAgentPrompt` threads the funnel's `agent_prompt_copy` step the same way, for
 * {@link AgentOnboardingCard} below. Same reason, same shape, separate action: the two
 * routes into building an app are the thing this page is trying to measure, so collapsing
 * them onto one event would make the comparison unanswerable.
 */
export function GetStartedBody({
  onCopyCommand,
  onCopyAgentPrompt,
}: {
  onCopyCommand?: (c: string) => void;
  onCopyAgentPrompt?: (prompt: string) => void;
} = {}) {
  const [opened, { toggle }] = useDisclosure(false);

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

      {/*
        The agent route, directly under the hero.
        🔴 ABOVE "What you get" ON PURPOSE AND BELOW THE BANNER ON PURPOSE. This is the ONE
        indexable state of `/apps/build`, so the card must not sit above the hero image that
        is this page's LCP element — and the hero image declares a fixed `aspect-ratio`, so
        nothing below it shifts.

        ⚠️ THE CARD IS NOT CLS-FREE, THOUGH, AND THIS COMMENT CLAIMED IT WAS. It read "the
        card itself introduces no asynchronous content, so it adds no layout shift of its
        own", which is wrong in a way worth stating here rather than only in the card: its
        blinking caret is inline content that exists only in the ANIMATED tree, so one commit
        after hydration it can push the prompt's last word onto a new line. Estimated at
        ~0.009 CLS — one line of ~21px against a ~900px viewport, over the ~40% of the page
        below this card — i.e. an order of magnitude under the 0.1 "good" threshold, and
        accepted on that basis. See `AgentOnboardingCard`'s header for the alternative that
        was weighed and declined. Corrected because this is the comment someone would trust
        if a CLS regression ever shows up on this route.
      */}
      <AgentOnboardingCard onCopy={onCopyAgentPrompt} tone="prominent" />

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

      <Divider />

      {/* Quickstart — copy 3 lines, you're running. Collapsed by default so the
          "what you get" pitch leads; the commands are one click away. */}
      <Stack gap="sm">
        <Title order={2}>Quickstart</Title>
        <Text size="sm" c="dimmed">
          Create a local Civitai app in 3 steps with the{' '}
          <Anchor href={CIVITAI_CLI_GITHUB_URL} target="_blank" rel="noopener noreferrer">
            Civitai CLI
          </Anchor>
        </Text>
        <Button
          variant="subtle"
          size="xs"
          onClick={toggle}
          aria-expanded={opened}
          w="fit-content"
          rightSection={
            <IconChevronDown
              size={16}
              style={{
                transform: opened ? 'rotate(180deg)' : undefined,
                transition: 'transform 150ms ease',
              }}
            />
          }
        >
          {opened ? 'Hide commands' : 'Show commands'}
        </Button>
        <Collapse in={opened} data-testid="quickstart-commands">
          <Stack gap="sm">
            <CopyableCommand command={CLI_INSTALL_BREW} onCopy={onCopyCommand} />
            <Text size="xs" c="dimmed">
              or: <Code>{CLI_INSTALL_GO}</Code>
            </Text>
            <CopyableCommand command={CLI_CREATE_SAMPLE_COMMAND} onCopy={onCopyCommand} />
            <CopyableCommand command={CLI_RUN_COMMAND} onCopy={onCopyCommand} />
          </Stack>
        </Collapse>
      </Stack>
    </Stack>
  );
}
