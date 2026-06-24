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
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

/**
 * The canonical public Civitai CLI repository. This is the recommended way to
 * author + submit an App Block — `civitai app create` scaffolds a block and
 * `civitai app submit` packages + uploads it (no hand-rolled ZIP).
 */
export const CIVITAI_CLI_GITHUB_URL = 'https://github.com/civitai/cli';

/** Install + author + submit one-liners promoted as the primary path. */
export const CLI_INSTALL_COMMAND = 'brew install civitai/tap/civitai';
export const CLI_CREATE_COMMAND = 'civitai app create';
export const CLI_SUBMIT_COMMAND = 'civitai app submit';

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
          >
            {copied ? <IconCheck size={16} /> : <IconClipboard size={16} />}
          </LegacyActionIcon>
        </Box>
      )}
    </CopyButton>
  );
}

/**
 * CLI-first submit CTA — the primary, recommended path for authoring and
 * submitting an App Block. Pure presentational (props-only, no network / no
 * tRPC), so it renders in isolation in component tests.
 *
 * The manual ZIP-upload flow is rendered separately and de-emphasized as a
 * secondary option (see /apps/submit).
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
            Recommended: use the Civitai CLI
          </Title>
        </Group>
      }
    >
      <Stack gap="md">
        <Text size="sm">
          The fastest way to author and ship an app is the <Code>civitai</Code> command-line tool.
          It scaffolds a block, runs it locally, packages your source, and submits it for review —
          no manual ZIP to build.
        </Text>

        <Stack gap={6}>
          <Text size="sm" fw={600}>
            1. Install
          </Text>
          <CopyableCommand command={CLI_INSTALL_COMMAND} />
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
