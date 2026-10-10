import { Anchor, Button, Code, Collapse, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChevronDown, IconTerminal2 } from '@tabler/icons-react';
import { useId } from 'react';
import {
  CIVITAI_CLI_GITHUB_URL,
  CLI_CREATE_SAMPLE_COMMAND,
  CLI_INSTALL_BREW,
  CLI_INSTALL_GO,
  CLI_INSTALL_NPM,
  CLI_RUN_COMMAND,
} from '~/components/Apps/cliCommands';
import { CopyableCommand } from '~/components/Apps/CopyableCommand';

const MANUAL_SETUP_TOGGLE_TESTID = 'apps-manual-setup-toggle';
const MANUAL_SETUP_REGION_TESTID = 'apps-manual-setup';

type ManualSetupProps = {
  /** Fired on an attempted copy of any command. Optional so this stays props-only. */
  onCopyCommand?: (command: string) => void;
};

/**
 * The manual CLI route (install, create, run), shared by all three `/apps/build` states so
 * they cannot disagree about which install command to show. npm leads because it is the only
 * one-liner that also covers Windows (see `./cliCommands`).
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

/**
 * {@link ManualSetupSteps} behind a toggle, closed by default, so the agent prompt leads.
 *
 * Mantine's `Collapse` keeps its children mounted while closed, so a test has to assert the
 * toggle's `aria-expanded` and the region's visibility, never mere presence.
 */
export function ManualSetupCollapse({ onCopyCommand }: ManualSetupProps) {
  const [opened, { toggle }] = useDisclosure(false);
  const regionId = useId();
  return (
    <Stack gap="xs">
      <Button
        variant="subtle"
        size="xs"
        onClick={toggle}
        aria-expanded={opened}
        aria-controls={regionId}
        w="fit-content"
        leftSection={<IconTerminal2 size={16} />}
        data-testid={MANUAL_SETUP_TOGGLE_TESTID}
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
        {opened ? 'Hide manual setup' : 'Set up manually with the CLI'}
      </Button>
      <Collapse in={opened} id={regionId} data-testid={MANUAL_SETUP_REGION_TESTID}>
        <ManualSetupSteps onCopyCommand={onCopyCommand} />
      </Collapse>
    </Stack>
  );
}
