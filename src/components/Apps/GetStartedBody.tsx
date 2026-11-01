import {
  Badge,
  Button,
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
} from '~/components/Apps/cliCommands';

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
 * NO BUILD ROUTES HERE. This body is what a viewer WITHOUT builder access sees (the pitch,
 * next to the Request access panel), so it does not carry the agent-onboarding prompt: it
 * needs access to be useful. The prompt lives in the `first-app` state and the workbench's
 * "Developer resources" strip, which only authors reach. (`/apps/build` shows no manual CLI
 * steps in any state.)
 *
 * Pure presentational (no props, no tRPC / no network) so it renders in
 * isolation in component tests.
 */
export function GetStartedBody() {
  return (
    <Stack gap="xl">
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
        Banner: 3:2 public asset, cropped to a fixed-height strip. At full width a 3:2 box is
        ~1300px tall on a wide screen and pushes the Request access panel below the fold. The
        fixed height still reserves its box before it loads.
      */}
      <Image
        src="/images/apps/civitai-apps-banner.webp"
        alt="Build apps on Civitai"
        radius="md"
        w="100%"
        h={240}
        fit="cover"
      />

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
