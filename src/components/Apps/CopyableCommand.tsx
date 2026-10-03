import { Code } from '@mantine/core';
import { CopyAffordance } from '~/components/Apps/CopyAffordance';

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
 * 🔴 THE MECHANICS NOW LIVE IN `./CopyAffordance` AND THIS IS A BODY ON TOP OF THEM. A
 * fourth consumer arrived — {@link AgentOnboardingCard}'s multi-line prose prompt — and it
 * cannot use this component, because what is special here is exactly what does not
 * generalise: the `$ ` shell sigil, `word-break: break-all`, and a `Copy command: …`
 * accessible name. Rather than duplicate the wiring a fourth time or make this render two
 * unrelated shells behind a `variant`, the shared half moved out. See `CopyAffordance`'s
 * header for why the seam is where it is.
 *
 * This file's rendered output is UNCHANGED by that move: the same `Box` click target, the
 * same absolutely-positioned icon at the same 8px offset, the same `aria-label`, the same
 * `Copied`/`$ command` swap, and the same `stopPropagation()` on the icon.
 */
export function CopyableCommand({
  command,
  onCopy,
}: {
  command: string;
  /**
   * Fired on an ATTEMPTED copy — the funnel's `cli_copy` step.
   *
   * 🔴 NOT "on a successful copy". The reason is in `CopyAffordance`'s `onCopy` doc, which
   * owns the call: `copy()` returns `void` and `CopyButton` surfaces no success signal, so a
   * denied clipboard permission still emits. The DOC was what got corrected rather than the
   * code — the funnel wants intent-to-copy.
   */
  onCopy?: (command: string) => void;
}) {
  return (
    <CopyAffordance value={command} label={`Copy command: ${command}`} onCopy={onCopy}>
      {({ copied }) => (
        <Code
          block
          color={copied ? 'green' : undefined}
          style={{ wordBreak: 'break-all', paddingRight: 36 }}
        >
          {copied ? 'Copied' : `$ ${command}`}
        </Code>
      )}
    </CopyAffordance>
  );
}
