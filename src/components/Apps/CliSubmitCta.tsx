import {
  Alert,
  Anchor,
  Box,
  Button,
  Code,
  CopyButton,
  Group,
  List,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconBrandGithub, IconCheck, IconClipboard, IconTerminal2 } from '@tabler/icons-react';
import {
  CIVITAI_CLI_GITHUB_URL,
  CIVITAI_CLI_RELEASES_URL,
  CLI_CREATE_COMMAND,
  CLI_INSTALL_BREW,
  CLI_INSTALL_GO,
  CLI_INSTALL_NPM,
  CLI_SUBMIT_COMMAND,
} from '~/components/Apps/cliCommands';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

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

/**
 * CLI-first submit CTA — the ONLY path for authoring and submitting an on-platform
 * App. Pure presentational (props-only, no network / no tRPC), so it renders in
 * isolation in component tests.
 *
 * ## 🔴 IT NO LONGER SAYS "Recommended"
 *
 * "Recommended: use the Civitai CLI" implies an alternative, and this page offers
 * none — the manual ZIP-upload flow does not exist here. Advertising a choice that
 * is not on offer sends the reader looking for the other option. The heading now
 * states what is true: this IS the way. (Of the two fixes available — drop the word,
 * or genuinely present the alternative — dropping it is the honest one, because
 * there is no alternative to present.)
 *
 * ## 🔴 EVERY PLATFORM GETS AN INSTALL ROUTE
 *
 * The single `brew` one-liner stopped a Windows or non-Homebrew Linux developer at
 * step 1 of 3. `npm` leads because it is the only one-liner that covers Windows;
 * brew and the prebuilt-binary download follow. Provenance for every route (and the
 * verification that they exist) is in {@link file://./cliCommands.ts}.
 */
export function CliSubmitCta() {
  return (
    <Alert
      color="blue"
      variant="light"
      p="lg"
      icon={<IconTerminal2 size={20} />}
      title={
        <Group gap={6}>
          <Title order={4} m={0}>
            Use the Civitai CLI
          </Title>
        </Group>
      }
    >
      <Stack gap="md">
        <Text size="sm">
          Apps are authored and submitted with the <Code>civitai</Code> command-line tool. It
          scaffolds a block, runs it locally, packages your source, and submits it for review — no
          manual ZIP to build.
        </Text>

        <Stack gap={6}>
          <Text size="sm" fw={600}>
            1. Install
          </Text>
          {/* 🔴 Pick ONE — but every platform must find itself here. npm is first
              because it is the only one-liner that works on Windows too. */}
          <Text size="xs" c="dimmed" data-testid="apps-cli-install-npm-label">
            Windows, macOS or Linux (needs Node):
          </Text>
          <CopyableCommand command={CLI_INSTALL_NPM} />
          <Text size="xs" c="dimmed" data-testid="apps-cli-install-brew-label">
            macOS or Linux, with Homebrew:
          </Text>
          <CopyableCommand command={CLI_INSTALL_BREW} />
          <Text size="xs" c="dimmed" data-testid="apps-cli-install-go-label">
            From source (Go 1.25+):
          </Text>
          <CopyableCommand command={CLI_INSTALL_GO} />
          <Text size="xs" c="dimmed" data-testid="apps-cli-install-binary">
            No toolchain? Download a prebuilt binary for Windows, macOS or Linux (amd64 or arm64)
            from{' '}
            <Anchor href={CIVITAI_CLI_RELEASES_URL} target="_blank" rel="noopener noreferrer">
              the CLI releases page
            </Anchor>
            , then put it on your PATH.
          </Text>
        </Stack>

        <Stack gap={6}>
          <Text size="sm" fw={600}>
            2. Create a new app
          </Text>
          <CopyableCommand command={CLI_CREATE_COMMAND} />
        </Stack>

        <Stack gap={6}>
          <Text size="sm" fw={600}>
            3. Submit for review
          </Text>
          <CopyableCommand command={CLI_SUBMIT_COMMAND} />
        </Stack>

        <List
          size="sm"
          spacing={4}
          icon={
            <ThemeIcon color="blue" size={18} radius="xl" variant="light">
              <IconCheck size={12} />
            </ThemeIcon>
          }
        >
          <List.Item>Scaffolds a valid manifest + project structure for you.</List.Item>
          <List.Item>Submits straight to the moderator review queue.</List.Item>
          <List.Item>Push new versions over git once your app is approved.</List.Item>
        </List>

        <Group>
          <Button
            component="a"
            href={CIVITAI_CLI_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            leftSection={<IconBrandGithub size={16} />}
          >
            Get the Civitai CLI
          </Button>
          <Text size="xs" c="dimmed">
            Docs + source:{' '}
            <Anchor href={CIVITAI_CLI_GITHUB_URL} target="_blank" rel="noopener noreferrer">
              github.com/civitai/cli
            </Anchor>
          </Text>
        </Group>
      </Stack>
    </Alert>
  );
}
