import { Code } from '@mantine/core';
import {
  COPY_BODY_PADDING_RIGHT,
  CopyAffordance,
} from '~/components/CopyAffordance/CopyAffordance';

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
 * 🔴 THE MECHANICS NOW LIVE IN `~/components/CopyAffordance/CopyAffordance` AND THIS IS A
 * BODY ON TOP OF THEM. A fourth consumer arrived — {@link AgentOnboardingCard}'s multi-line
 * prose prompt — and it cannot use this component, because what is special here is exactly
 * what does not generalise: the `$ ` shell sigil and a `Copy command: …` accessible name.
 * Rather than duplicate the wiring a fourth time or make this render two unrelated shells
 * behind a `variant`, the shared half moved out. See `CopyAffordance`'s header for why the
 * seam is where it is.
 *
 * ⚠️ `word-break: break-all` WAS THE THIRD ITEM IN THAT LIST AND HAS BEEN REMOVED FROM IT.
 * `<Code block>` computes `white-space: pre` / `nowrap`, so nothing soft-wraps and the
 * property is INERT here — measured in
 * `src/components/CopyAffordance/CopyAffordance.geometry.test.tsx`, where this component's own
 * long-command fixture scrolls (`scrollWidth` 572 against `clientWidth` 390, computed
 * `white-space: pre` / `text-wrap-mode: nowrap` / `overflow-x: auto`). It is LEFT on the body
 * below rather than deleted: inert under the geometry measured here is not the same claim as
 * output-neutral to remove at every call site, and nobody has measured the second. Do not
 * cite it as a reason this body is special; do not read its presence as a reason either.
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
          style={{ wordBreak: 'break-all', paddingRight: COPY_BODY_PADDING_RIGHT }}
        >
          {copied ? 'Copied' : `$ ${command}`}
        </Code>
      )}
    </CopyAffordance>
  );
}
