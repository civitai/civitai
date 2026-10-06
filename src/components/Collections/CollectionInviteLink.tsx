import { Box, Code, CopyButton } from '@mantine/core';
import { IconClipboard } from '@tabler/icons-react';
import { copyBodyPaddingRight } from '~/components/CopyAffordance/CopyAffordance';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

/** The copy control's accessible name — the icon carries no text, so without it: "button". */
export const INVITE_LINK_COPY_LABEL = 'Copy the collection invite link';

/**
 * The control's inset from the body's right edge.
 *
 * ⚠️ 10, NOT `COPY_ICON_INSET`'s 8 — AND THAT IS WHY THIS BLOCK NEEDS ITS OWN PADDING RATHER
 * THAN `COPY_BODY_PADDING_RIGHT`. The value is pre-existing and nothing records a reason for
 * it; it is kept because moving it is a rendered-output change this fix did not need to make,
 * not because 10 is better than 8. If it ever moves, the padding below moves with it by
 * construction.
 *
 * 🔴 NOT EXPORTED, AND THAT IS THE POINT. It is both the control's `right=` prop and a term in
 * the padding derived from it, so a test that imported it would be checking the implementation
 * against itself on both sides. The geometry suite reads the inset off the RENDERED control
 * instead; keeping this module-local is what makes that a property of the code rather than a
 * convention a reviewer has to notice.
 */
const INVITE_LINK_ICON_INSET = 10;

/**
 * The clearance this body reserves, from the one shared rule.
 *
 * 🔴 ITS ABSENCE WAS A **LATENT** OVERLAP, NOT A LIVE ONE — AND THIS SENTENCE SAID "LIVE"
 * UNTIL REVIEW CAUGHT THAT THE SAME COMMIT REFUTES IT. The control is absolutely positioned
 * over the body, so with no right padding the invite URL's tail falls underneath the clipboard
 * icon. But no invite URL ever reached the browser: the `env` read backing it was
 * `import { env } from 'process'` (see `CollectionEditModal.tsx`), so `joinUrl` was `''`
 * unconditionally and the body was always empty. Nothing was under the icon because nothing
 * was there at all. Fixing that import is what makes this overlap REACHABLE, which is why both
 * fixes belong in one commit — and the honest basis for this padding is "the body reserves no
 * clearance, and a non-empty URL now renders here", not a user-visible symptom anyone saw.
 *
 * The magnitudes are measured in `src/components/CopyAffordance/CopyAffordance.geometry.test.tsx`,
 * which mounts this component and reports the clearance in its own failure messages.
 *
 * Module-local for the same reason as the inset: nothing outside needs it, and it looks enough
 * like a sibling of `COPY_BODY_PADDING_RIGHT` — which six bodies legitimately import — to be
 * mis-imported, while being correct for exactly one body.
 *
 * It is a `rem()` string, via {@link copyBodyPaddingRight}, because the other two terms scale
 * with the root font size: the inset goes through Mantine's `right=` style prop, and the
 * control's border box is `--ai-size-md`, which in the stylesheet this app imports is
 * `calc(1.75rem * var(--mantine-scale))`. A raw px number here would hold at a 16px root font
 * size and fail above it — the exact defect `COPY_BODY_PADDING_RIGHT`'s own doc records.
 */
const INVITE_LINK_BODY_PADDING_RIGHT = copyBodyPaddingRight(INVITE_LINK_ICON_INSET);

/** Scopes the geometry fixture to this block's `Box`, rather than to any `pre` on the page. */
export const INVITE_LINK_TESTID = 'collection-invite-link-copy';

/**
 * The contest collection's invite-link value, with a copy control over its right edge.
 *
 * 🔴 EXTRACTED FROM `CollectionEditModal` SO IT CAN BE MOUNTED. Both defects fixed here are
 * ones a test has to RENDER to see — an empty string reaching the clipboard, and a box
 * overlapping another box — and the modal itself needs tRPC, a dialog context, form state and
 * `~/env/client` to mount at all. `joinUrl` is a plain prop, so this component is props-only
 * (no tRPC / no network / no env) and both its suites mount it with the harness's providers
 * and nothing else.
 *
 * ⚠️ DELIBERATELY NOT ROUTED THROUGH `~/components/CopyAffordance/CopyAffordance`, unlike the
 * `Code`-block copies in `Account/` — and it needs TWO new props there, not one. That component
 * models no disabled state (and `bodyClickCopies={false}` is not a substitute: its icon's own
 * `onClick` is unconditional, so the control would still copy `''`), AND its inset is emitted
 * as an inline style, which `iconClassName` cannot override — so a caller at `right={10}` needs
 * an `inset` prop too. Two new props on seven live consumers, none of which exercises a
 * disabled state, to absorb ~25 lines of markup carrying one predicate. What those bodies
 * genuinely share — the clearance arithmetic — is imported as {@link copyBodyPaddingRight}
 * instead, so the one thing that was actually duplicated is not.
 *
 * ⚠️ THE CLEARANCE IS A CLAIM ABOUT A URL THAT *FITS*, AND NOTHING MORE. `<Code block>`
 * computes `white-space: pre` / `overflow-x: auto`, so a URL wider than the content box
 * scrolls rather than wrapping, and a scrolling `pre` paints across its own right padding.
 * Same caveat, same mechanism, as `COPY_BODY_PADDING_RIGHT`'s.
 */
export function CollectionInviteLink({ joinUrl }: { joinUrl: string }) {
  return (
    <CopyButton value={joinUrl}>
      {({ copied, copy }) => {
        // 🔴 ONE PREDICATE FOR BOTH THE CONTROL AND THE BODY CLICK. The icon's `disabled` and
        // the `Box`'s `onClick` are two gates on one condition, and they used to disagree:
        // `disabled={!joinUrl}` sat on the icon while `onClick={copy}` sat on the wrapping
        // `Box`, so a click anywhere on the value copied `''` to the clipboard and flipped the
        // label to "Copied" — telling the user they had copied an invite link when they had
        // copied nothing. The icon being disabled did not matter: it is not what was clicked.
        const canCopy = !!joinUrl;
        return (
          <Box
            pos="relative"
            onClick={canCopy ? copy : undefined}
            style={canCopy ? { cursor: 'pointer' } : undefined}
            data-testid={INVITE_LINK_TESTID}
          >
            <LegacyActionIcon
              pos="absolute"
              top="50%"
              right={INVITE_LINK_ICON_INSET}
              variant="transparent"
              // 🔴 NO `!important` HERE, AND REMOVING IT IS A BEHAVIOUR FIX, NOT A TIDY-UP.
              // This read `translateY(-50%) !important`, and `!important` is not valid in a
              // value assigned through the CSSOM property setter — which is how React writes
              // non-custom style properties — so the whole declaration was DROPPED. Measured
              // at 390x844: `getComputedStyle(control).transform` was `none`, leaving the
              // control at `top: 50%` with no correction, its box running 19.3→47.3 against a
              // body of 0→38.59 — hanging 8.7px BELOW the body it sits in, rather than
              // centred on it. With the `!important` gone the declaration applies and the
              // control centres. Pinned by the vertical assertions in
              // `src/components/CopyAffordance/CopyAffordance.geometry.test.tsx`; found by
              // review, because every assertion in that block was horizontal.
              style={{ transform: 'translateY(-50%)' }}
              disabled={!canCopy}
              aria-label={INVITE_LINK_COPY_LABEL}
            >
              <IconClipboard />
            </LegacyActionIcon>
            <Code
              block
              color={copied ? 'green' : undefined}
              // The control's own width, reserved — see `INVITE_LINK_BODY_PADDING_RIGHT`.
              style={{ paddingRight: INVITE_LINK_BODY_PADDING_RIGHT }}
            >
              {copied ? 'Copied' : joinUrl}
            </Code>
          </Box>
        );
      }}
    </CopyButton>
  );
}
