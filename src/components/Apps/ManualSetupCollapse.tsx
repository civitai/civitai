import { Anchor, Code, Stack, Text } from '@mantine/core';
import {
  CIVITAI_CLI_GITHUB_URL,
  CLI_CREATE_SAMPLE_COMMAND,
  CLI_INSTALL_BREW,
  CLI_INSTALL_GO,
  CLI_INSTALL_NPM,
  CLI_RUN_COMMAND,
} from '~/components/Apps/cliCommands';
import { CopyableCommand } from '~/components/Apps/CopyableCommand';

type ManualSetupProps = {
  /** Fired on an attempted copy of any command. Optional so this stays props-only. */
  onCopyCommand?: (command: string) => void;
};

/**
 * The manual CLI route (install, create, run), rendered inside the `/apps/build` workbench's
 * "Developer resources" strip. npm leads because it is the only one-liner that also covers
 * Windows (see `./cliCommands`).
 */
export function ManualSetupSteps({ onCopyCommand }: ManualSetupProps) {
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Three steps with the{' '}
        <Anchor href={CIVITAI_CLI_GITHUB_URL} target="_blank" rel="noopener noreferrer">
          Civitai CLI
        </Anchor>
        : install it, create an app, run it locally.
      </Text>
      <CopyableCommand command={CLI_INSTALL_NPM} onCopy={onCopyCommand} />
      <Stack gap={4}>
        <Text size="xs" c="dimmed">
          Or with Homebrew on macOS or Linux: <Code>{CLI_INSTALL_BREW}</Code>
        </Text>
        <Text size="xs" c="dimmed">
          Or from source: <Code>{CLI_INSTALL_GO}</Code>
        </Text>
      </Stack>
      <CopyableCommand command={CLI_CREATE_SAMPLE_COMMAND} onCopy={onCopyCommand} />
      <CopyableCommand command={CLI_RUN_COMMAND} onCopy={onCopyCommand} />
    </Stack>
  );
}
