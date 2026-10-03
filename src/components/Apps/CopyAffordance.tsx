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
 * ⚠️ AND THE COUNT WAS ALREADY HIGHER THAN THAT STORY SAYS — TWICE OVER, WHICH IS THE HALF
 * WORTH KEEPING. This header read "SO THERE IS NOT A FOURTH COPY" until a review found a
 * fifth: `AuthorViaGit.tsx` carried a private `CopyableCode` byte-identical to
 * `CopyableCommand`'s pre-extraction body — the same `Box`, the same `Code` props, the same
 * absolutely-positioned icon at the same 8px offset — and it had ALREADY DRIFTED in exactly
 * the way `CopyableCommand`'s header warns about: `aria-label="Copy"`, rendered twice on one
 * panel, so a screen-reader user heard "Copy" and "Copy" with nothing to tell the clone URL
 * from the setup steps. It is converted here, which is what fixed that.
 *
 * 🔴 AND THEN THE CORRECTION WAS WRONG IN THE SAME WAY. "A fifth" was derived over
 * `src/components/Apps/` alone; the same shell also sits in `Account/ApiKeyModal.tsx`,
 * `Account/OAuthAppsCard.tsx` (three times) and `Collections/CollectionEditModal.tsx` —
 * several of them secret-bearing with NO accessible name at all, which is worse than the
 * bare "Copy" this change fixed. **So no total is stated here.** The scope this component
 * claims, and the only scope `__tests__/copyAffordanceLedger.test.ts` enforces, is
 * `src/components/Apps/`. Consolidating the rest is real work for another change, and the
 * lesson is the one this paragraph has now demonstrated against itself twice: a count in a
 * comment is a thing to re-derive, never to trust — including this one.
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
 * more than this uses, and it also accepts `value` as a thunk.
 *
 * The honest reason is scope, not incompatibility. An earlier draft of this note claimed
 * adopting it "would change `CopyableCommand`'s rendered output"; that is NOT true — the
 * `Icon`/`color` it yields are suggestions a consumer can ignore, so this component could
 * adopt it and keep rendering `IconClipboard`/`green` unchanged. What is true is that
 * swapping the wrapper under an extraction whose whole promise is "the rendered output does
 * not change" means re-verifying three existing call sites for a seam that is already one
 * layer deep. Which of the two is canonical is worth deciding once, deliberately, for the
 * whole repo — not as a side effect of this change.
 */
export function CopyAffordance({
  value,
  label,
  onCopy,
  iconClassName = 'absolute right-2 top-1/2 -translate-y-1/2',
  renderGlyph,
  bodyClickCopies = true,
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
  /**
   * Whether clicking the BODY copies, as well as the control. Default `true`.
   *
   * 🔴 `false` FOR A PROSE BODY, AND THAT IS A DELETION THAT CLOSED FIVE REVIEW FINDINGS
   * RATHER THAN A PREFERENCE. A body-wide click target fights text selection, because the
   * `mouseup` ending a drag-select is followed by a `click` on the same element. Guarding it
   * was tried and abandoned: a selection test at `click` time could not tell a drag-select
   * from a stale selection (so a stale one silently disabled the panel), keyed on
   * `anchorNode` it missed a shift-click extension — which on `AuthorViaGit` put a live push
   * token on the clipboard from a gesture that was not a copy — and its scoping half was
   * itself unguarded, where losing it would have let any selection anywhere on the page
   * suppress every copy. Three timing-dependent failure modes to keep a convenience on a
   * body nobody needs to click.
   *
   * So prose bodies opt out and the control is the only copy path — it is a real `<button>`,
   * reachable by Tab, with its own accessible name. One-line COMMAND blocks keep the
   * body click: selecting a fragment of `npm install -g @civitai/cli` is not a thing people
   * do, the affordance predates this component at all three of those call sites, and leaving
   * the default `true` is what keeps `onCopy`'s "fires on an ATTEMPTED copy" contract exactly
   * as documented for them.
   */
  bodyClickCopies?: boolean;
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
        return (
          <Box
            pos="relative"
            onClick={bodyClickCopies ? handleCopy : undefined}
            style={bodyClickCopies ? { cursor: 'pointer' } : undefined}
            data-testid={testId}
          >
            {children({ copied })}
            <LegacyActionIcon
              className={iconClassName}
              // Duplicates the Tailwind `right-2` in the default class (both 8px) as an
              // inline style, so the offset survives a utility-class purge. See
              // {@link COPY_ICON_INSET} for why the number is shared rather than retyped.
              right={COPY_ICON_INSET}
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

/**
 * The icon's inset from the body's right edge, and the clearance a body must leave for it.
 *
 * 🔴 ONE COUPLING, ONE PLACE. These two numbers are not independent: the control is
 * absolutely positioned `COPY_ICON_INSET` from the right, is 16px wide, and a body that does
 * not reserve at least their sum plus breathing room renders its own text UNDER the icon.
 * That has already happened once in this component family — the agent prompt's panel had a
 * Tailwind `p-3` shorthand resetting the `padding-right` its stylesheet set, and the
 * clipboard glyph landed on the first line's last word. Before this, the pair was spelled by
 * hand in `CopyableCommand.tsx` and `AuthorViaGit.tsx` (`paddingRight: 36` beside
 * `right={8}`), so the two halves of one geometric fact lived in three files.
 */
export const COPY_ICON_INSET = 8;
/** Right padding a `Code`-style body must carry so the control never overlaps its text. */
export const COPY_BODY_PADDING_RIGHT = 36;

/** The default glyph pair, exported so a `renderGlyph` can wrap it rather than restate it. */
export function CopyGlyph({ copied, size = 16 }: { copied: boolean; size?: number }) {
  return copied ? <IconCheck size={size} /> : <IconClipboard size={size} />;
}
