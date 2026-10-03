import type { MouseEvent, ReactNode } from 'react';
import { Box, CopyButton } from '@mantine/core';
import { IconCheck, IconClipboard } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

/**
 * The copy-to-clipboard MECHANICS, with no opinion about what is being copied.
 *
 * 🔴 EXTRACTED SO THE COPY COUNT STOPS GROWING. `CopyableCommand` exists because
 * `GetStartedBody` and `CliSubmitCta` each carried a byte-identical private copy of a copy
 * button and `/apps/build` needed a third; its own header records that. The agent prompt
 * cannot reuse `CopyableCommand` itself, because that component renders `` `$ ${command}` ``
 * — a shell prompt sigil in front of a one-line command, inside a `Code block` with
 * `word-break: break-all`. The prompt is multi-line prose, so it would render as
 * "$ Read https://…" with its words broken mid-token, and `CopyableCommand`'s `aria-label`
 * is literally `Copy command: …`.
 *
 * ⚠️ AND THE COUNT WAS ALREADY HIGHER THAN THAT STORY SAYS, which is the half worth keeping.
 * This header read "SO THERE IS NOT A FOURTH COPY" until the reuse review found a fifth:
 * `AuthorViaGit.tsx` carried a private `CopyableCode` that was byte-identical to
 * `CopyableCommand`'s pre-extraction body — the same `Box`, the same `Code` props, the same
 * absolutely-positioned icon at the same 8px offset — and it had ALREADY DRIFTED in exactly
 * the way `CopyableCommand`'s header warns about: `aria-label="Copy"`, rendered twice on one
 * panel, so a screen-reader user heard "Copy" and "Copy" with nothing to tell the clone URL
 * from the setup steps. It is converted to this component in the same change, which is what
 * fixed that. Treat a confident count in a comment as the thing to re-derive, not to trust.
 *
 * So this is the seam instead of a `variant` prop on `CopyableCommand`: a variant would
 * make one component render two structurally unrelated shells (a `Code` block and a prose
 * panel) and carry two accessible-name schemes, which is a component doing two jobs rather
 * than a shared mechanism. What is genuinely common is exactly the four things
 * `CopyableCommand`'s header named as the drift it prevents — the `CopyButton` wiring, the
 * `aria-label`, the copied-state feedback, and the `stopPropagation()` on the inner icon —
 * and those are what live here. The BODY is a render prop; both consumers supply their own.
 *
 * `onCopy` is OPTIONAL and defaults to nothing. That is what keeps `GetStartedBody`,
 * `CliSubmitCta` and {@link AgentOnboardingCard} the "pure presentational (props-only, no
 * tRPC / no network)" components their headers claim — a property their
 * `*.browser.test.tsx` suites depend on, since they mount them with no providers. The
 * analytics call lives at the ONE call site that has a tracker (`AppsBuildBody`), threaded
 * down as a callback rather than by importing a hook in here.
 *
 * ⚠️ WHY MANTINE'S `CopyButton` AND NOT `~/components/CopyButton/CopyButton`. The repo has
 * its own wrapper that yields `{copied, copy, Icon, color}` over `useClipboard` — strictly
 * more than this uses. It is deliberately not adopted: its `Icon`/`color` are `IconCopy` and
 * `teal`, while every copy affordance under `src/components/Apps/` is `IconClipboard` and
 * `green`, so switching would change `CopyableCommand`'s rendered output, which this
 * extraction promises it does not. Worth revisiting as a single decision about which wrapper
 * is canonical — but as a deliberate change to both glyph sets, not as a side effect of
 * extracting a seam.
 */
export function CopyAffordance({
  value,
  label,
  onCopy,
  iconClassName = 'absolute right-2 top-1/2 -translate-y-1/2',
  renderGlyph,
  children,
  'data-testid': testId,
}: {
  /** The exact bytes handed to the clipboard. */
  value: string;
  /** The copy control's accessible name. Consumer-supplied — "command" is not universal. */
  label: string;
  /**
   * Fired on an ATTEMPTED copy — not on a successful one.
   *
   * 🔴 NOT "on a successful copy", which is what `CopyableCommand`'s prop doc said once and
   * what the code cannot deliver. `handleCopy` calls Mantine's `copy()` and then `onCopy?.()`
   * unconditionally; `copy()` returns `void` and `CopyButton` surfaces no success signal, so
   * there is nothing to branch on. A denied clipboard permission or a non-secure context
   * still emits. Gating the step on a signal Mantine does not expose would mean
   * reimplementing the copy itself.
   */
  onCopy?: (value: string) => void;
  /** Where the icon sits. The default is the command block's right-middle. */
  iconClassName?: string;
  /**
   * Presentation of the clipboard/check glyph. Defaults to the plain icon swap.
   *
   * This is the ONLY seam the two consumers differ on beyond the body: the agent card pops
   * the glyph as it morphs. The wiring around it — which element is clicked, what it is
   * called, that it does not double-fire — stays here for both.
   */
  renderGlyph?: (copied: boolean) => ReactNode;
  /** The copyable body. Receives `copied` so it can show its own copied state. */
  children: (state: { copied: boolean }) => ReactNode;
  'data-testid'?: string;
}) {
  return (
    <CopyButton value={value}>
      {({ copied, copy }) => {
        const handleCopy = () => {
          copy();
          onCopy?.(value);
        };
        /**
         * 🔴 A CLICK THAT ENDS A TEXT SELECTION INSIDE THE BODY IS NOT A COPY REQUEST.
         * Selecting part of the text ends with a `mouseup`, which the browser follows with a
         * `click` on this `Box` — so without this guard, highlighting a phrase immediately
         * OVERWRITES the user's selection with the whole value and posts a funnel event they
         * never asked for, and a double-click (which selects a word) posts two. Harmless on
         * `CopyableCommand`'s one-line command block, which is why it went unnoticed; the
         * agent prompt is two paragraphs of prose at full container width on a public page,
         * where selecting a fragment is an ordinary thing to do.
         *
         * Scoped to a selection ANCHORED INSIDE this element, so a stray selection elsewhere
         * on the page cannot suppress a legitimate click here. The ICON path below is
         * deliberately NOT guarded: pressing an explicit button is an unambiguous request,
         * and it is the escape hatch for someone who does want to copy everything after
         * selecting something.
         */
        const handleBodyClick = (e: MouseEvent<HTMLDivElement>) => {
          const selection = typeof window !== 'undefined' ? window.getSelection() : null;
          if (
            selection &&
            !selection.isCollapsed &&
            selection.anchorNode &&
            e.currentTarget.contains(selection.anchorNode)
          ) {
            return;
          }
          handleCopy();
        };
        return (
          <Box
            pos="relative"
            onClick={handleBodyClick}
            style={{ cursor: 'pointer' }}
            data-testid={testId}
          >
            {children({ copied })}
            <LegacyActionIcon
              className={iconClassName}
              // Carried over from `CopyableCommand` verbatim. It duplicates the Tailwind
              // `right-2` in the default class (both 8px) as an inline style, so the offset
              // survives a utility-class purge; both consumers want the same 8px, so it is a
              // default here rather than another prop.
              right={8}
              variant="transparent"
              color="gray"
              aria-label={label}
              // 🔴 STOPS PROPAGATION, WHICH THE THREE PRIVATE COPIES DID NOT. The icon sits
              // INSIDE the Box that also handles the click, so a press on the icon ran
              // `copy()` twice. Harmless while copying was the only effect — the second write
              // is idempotent — but `onCopy` is not: it would post two funnel events for one
              // press, and only for the icon, so the funnel would over-count by however many
              // users aim at the button rather than the block.
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                handleCopy();
              }}
            >
              {renderGlyph ? (
                renderGlyph(copied)
              ) : copied ? (
                <IconCheck size={16} />
              ) : (
                <IconClipboard size={16} />
              )}
            </LegacyActionIcon>
          </Box>
        );
      }}
    </CopyButton>
  );
}

/** The default glyph pair, exported so a `renderGlyph` can wrap it rather than restate it. */
export function CopyGlyph({ copied, size = 16 }: { copied: boolean; size?: number }) {
  return copied ? <IconCheck size={size} /> : <IconClipboard size={size} />;
}
