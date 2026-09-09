import type { MouseEvent } from 'react';
import { Box, Code, CopyButton } from '@mantine/core';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { IconCheck, IconClipboard } from '@tabler/icons-react';

/**
 * A copy-to-clipboard shell command block.
 *
 * 🔴 EXTRACTED FROM THREE PLACES, NOT WRITTEN FOR A NEW ONE. `GetStartedBody` and
 * `CliSubmitCta` each carried a byte-identical private copy of this component, and
 * `/apps/build` needed a third. Three copies of one affordance is how the two surfaces
 * that are meant to teach the SAME quickstart drift in their copy button, their
 * `aria-label` and their copied-state feedback — which is the drift `./cliCommands`
 * already exists to prevent for the command STRINGS. Same rule, one level out.
 *
 * `onCopy` is OPTIONAL and defaults to nothing, which is what keeps `GetStartedBody`
 * and `CliSubmitCta` the "pure presentational (props-only, no tRPC / no network)"
 * components their headers claim they are — a property their `*.browser.test.tsx`
 * suites depend on, since they mount them with no providers. The analytics call lives
 * at the ONE call site that has a tracker (`AppsBuildBody`), threaded down as a
 * callback rather than by importing a hook in here.
 */
export function CopyableCommand({
  command,
  onCopy,
}: {
  command: string;
  /**
   * Fired on an ATTEMPTED copy — the funnel's `cli_copy` step.
   *
   * 🔴 NOT "on a successful copy", which is what this said and what the code cannot
   * deliver. `handleCopy` calls Mantine's `copy()` and then `onCopy?.()`
   * unconditionally; `copy()` returns `void` and `CopyButton` surfaces no success
   * signal, so there is nothing to branch on. A denied clipboard permission or a
   * non-secure context still emits the event. The DOC is what was corrected rather
   * than the code: the funnel wants intent-to-copy, and gating the step on a signal
   * Mantine does not expose would mean reimplementing the copy itself.
   */
  onCopy?: (command: string) => void;
}) {
  return (
    <CopyButton value={command}>
      {({ copied, copy }) => {
        const handleCopy = () => {
          copy();
          onCopy?.(command);
        };
        return (
          <Box pos="relative" onClick={handleCopy} style={{ cursor: 'pointer' }}>
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
              // 🔴 STOPS PROPAGATION, WHICH THE THREE PRIVATE COPIES DID NOT. The icon
              // sits INSIDE the Box that also handles the click, so a press on the icon
              // ran `copy()` twice. Harmless while copying was the only effect — the
              // second write is idempotent — but `onCopy` is not: it would post two
              // `cli_copy` events for one press, and only for the icon, so the funnel
              // would over-count by however many users aim at the button rather than
              // the block. Fixed here rather than left for the analytics to work around.
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                handleCopy();
              }}
            >
              {copied ? <IconCheck size={16} /> : <IconClipboard size={16} />}
            </LegacyActionIcon>
          </Box>
        );
      }}
    </CopyButton>
  );
}
