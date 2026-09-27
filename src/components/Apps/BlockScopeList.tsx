import { Badge, Group, Stack, Text } from '@mantine/core';
import { SensitiveScopeBadge } from '~/components/Apps/SensitiveScopeBadge';
import { isSensitiveBlockScope } from '~/shared/constants/block-scope.constants';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';

/**
 * Renders a list of block scope ids as a badge + friendly-description list. Unknown scopes (not
 * in SCOPE_DESCRIPTIONS) render as a bare badge with an italic "(no description)" — keeping the
 * description map a soft contract so new scopes ship without breaking the UI.
 *
 * 🔴 THIS COMPONENT IS PRESENTATION ONLY AND MAKES NO CLAIM ABOUT WHICH SET IT IS HANDED.
 * ⚠️ The previous docstring said it was "shared by the install/manage modal … and the
 * /apps/activity panel so the two surfaces never drift". That guarantee was false and is DELETED
 * rather than restated: there are FOUR call sites and they are fed from THREE different sets, by
 * design —
 *
 *   - `src/pages/apps/activity.tsx` and `src/components/AppBlocks/AppPermissionsActivityDrawer.tsx`
 *     pass `listMyScopeGrants().scopes` = `manifest.scopes ∩ approved_scopes`.
 *   - `src/components/Apps/AppSettingsModal.tsx` passes `installConfig?.scopes ?? manifest.scopes
 *     ?? []` — that same intersection when `getInstallConfig` has resolved, but falling back to
 *     the RAW manifest on the Manage path when it has not. Pre-existing; not changed here.
 *   - `src/components/Apps/AppListingDetailBody.tsx` passes `detail.scopes` = RAW
 *     `approved_scopes`, with no intersection, deliberately — it is a PUBLIC pre-launch
 *     disclosure and over-disclosing the stale approval is the safe direction there. The
 *     reasoning lives at `src/server/services/blocks/app-listing.service.ts`; do not "align" it.
 *
 * So the set is the CALLER'S choice and each caller documents its own. A docstring here that
 * promised they agree would read as coverage while providing none.
 *
 * 🔴 THE SCOPE ID IS NEVER TRUNCATED, AT ANY WIDTH. Badge and description used to share one
 * `wrap="nowrap"` row, which at the ~408px `AppPermissionsActivityDrawer` ellipsised the id
 * — the one string the row exists to disclose. Unconditional rather than narrow-only: a long
 * enough id reaches the ellipsis at any container width; 408px only makes it certain. Measured
 * in `AppsWideLayout.geometry.test.tsx`'s drawer-width arms.
 *
 * Three declarations undo the clipping, and a mutation sweep kills each one on its own:
 * `whitespace-normal` lets the label wrap; `break-all` lets it wrap MID-TOKEN (a scope id has
 * no spaces, so `normal` alone finds no break opportunity and the id still ellipsises, at 16px
 * of label height against a wrapped 32); `h="auto"` lets the Badge ROOT grow with it, since
 * Mantine pins the root to one line and clips the overflow. `text-start` is the fourth and is
 * NOT decoration — Mantine's Badge label is `text-align: center`, so a wrapped identifier
 * centres and reads as prose. Nothing asserts that one.
 *
 * Spelled as Mantine `classNames` + Tailwind utilities rather than a CSS module because that is
 * this repo's idiom for the same Badge problem. The exact precedent is
 * `TrainingImagesTagViewer.tsx`, whose tag Badge takes
 * `classNames={{ label: 'overflow-auto break-words whitespace-normal text-start' }}` plus a
 * `height: auto` class; `ContestCommunityScore.tsx` is the same fix with `h="auto"` +
 * `classNames={{ label: 'whitespace-normal' }}`, which is the lighter spelling used here. The
 * `Apps/` folder breaks a machine identifier with an inline `style={{ wordBreak: 'break-all' }}`
 * (`ReportTabs.tsx`, `AppListingDetailBody.tsx`, `reviewDiffPanels.tsx`) — the same CSS value;
 * `openExternalLinkWarning.tsx` is the precedent for the UTILITY spelling of it. Utilities are
 * UNLAYERED, so they also beat Mantine's own rules more robustly than a `modules`-layer rule.
 *
 * ⚠️ TWO OTHER LIVE SURFACES PUT A SCOPE ID IN AN ELLIPSISING BADGE AND STILL TRUNCATE IT,
 * deliberately not changed here. Start with `OnsiteReviewModal.tsx`'s `ManifestScopeRow`: it is
 * the NEAR-LITERAL shape this file just replaced — a `wrap="nowrap"` Group holding an unhardened
 * Badge, then `SensitiveScopeBadge`, then the description — and it is the MODERATOR MANIFEST
 * REVIEW, where the exact scope string is the approve/reject input. `AppDetailsModal.tsx` is the
 * same shape rather than the same code (a `List.Item`, an `outline`/`gray`/`xs` Badge, no
 * `SensitiveScopeBadge`, and a `SCOPE_DESCRIPTIONS[scope] ?? scope` fallback that prints an
 * undescribed id twice). Neither is a drop-in for this component.
 * ⚠️ THE ENUMERATION IS "IN AN ELLIPSISING BADGE", NOT "EVERY SURFACE SHOWING A SCOPE ID":
 * `BlockConsentModal.tsx` renders `SCOPE_DESCRIPTIONS[scope] ?? scope`, so an UNDESCRIBED scope
 * reaches the screen there as a raw id — in a `Text`, not a Badge, so it cannot ellipsise, which
 * is why it is out of this fix's scope rather than missing from it.
 */
export function BlockScopeList({
  scopes,
  emptyLabel = "This app doesn't request any permissions — it only consumes data from the host-bridge postMessage protocol.",
}: {
  scopes: string[];
  emptyLabel?: string;
}) {
  if (scopes.length === 0) {
    return (
      <Text size="xs" c="dimmed" fs="italic">
        {emptyLabel}
      </Text>
    );
  }
  return (
    /* 🔴 THE OUTER GAP MUST EXCEED THE INNER ONE, or the list stops saying which description
       belongs to which id — the single mapping this surface exists to communicate. With both at
       4/2 the cue was a 2px differential, and it gets weaker exactly where this change helps: a
       wrapped id makes each scope block ~36px tall and the 2px is a smaller fraction of it.
       Pinned by the geometry arm, which compares the two gaps rather than asserting either. */
    <Stack gap="xs" data-testid="block-scope-list">
      {scopes.map((scope) => {
        const desc = SCOPE_DESCRIPTIONS[scope];
        const sensitive = isSensitiveBlockScope(scope);
        return (
          <Stack key={scope} gap={2}>
            {/* `wrap="nowrap"` keeps the "Sensitive" marker BESIDE the id it qualifies: under
                `flex-wrap: nowrap` no item can move to a line of its own.
                ⚠️ AND THE SYMPTOM `break-all` PREVENTS IS THE ID BEING ELLIPSISED — not the row
                overflowing, and not a wrapped marker. Two earlier revisions named those instead.
                What keeps the row inside is Mantine's own `width: fit-content` on the Badge root,
                which clamps to the available inline space; `globals.css`'s UNLAYERED
                `.mantine-Badge-root { flex-shrink: 0 }` only stops the Badge shrinking BELOW its
                flex base size, and that base size is already the clamp. `break-all` does not widen
                or narrow anything — the label's automatic minimum size has already collapsed to
                zero under Mantine's own `overflow: hidden` — it makes the clamped width able to
                HOLD the id wrapped instead of ellipsising it. Which is why the geometry arm catches
                its removal on the one-line HEIGHT: that file records its own overflow detector as
                reached by no mutant, because Mantine clips first.
                And the margin is narrower than it looks: no arm builds a long SENSITIVE id,
                because none is constructible — the longest sensitive scope in
                `SENSITIVE_BLOCK_SCOPES` is 25 chars. */}
            {/* `align="center"` rather than the pre-change `flex-start`: once the id can wrap to
                two lines, the "Sensitive" marker reads as belonging to the pill as a whole rather
                than to its first line. Cosmetic, and nothing asserts it. */}
            <Group gap="xs" wrap="nowrap" align="center">
              <Badge
                size="sm"
                variant="light"
                color={sensitive ? 'orange' : undefined}
                h="auto"
                classNames={{ label: 'whitespace-normal break-all text-start' }}
                data-testid="block-scope-id"
              >
                {scope}
              </Badge>
              {sensitive && <SensitiveScopeBadge size="sm" />}
            </Group>
            {desc ? (
              <Text size="xs" c="dimmed">
                {desc}
              </Text>
            ) : (
              <Text size="xs" c="dimmed" fs="italic">
                (no description)
              </Text>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}
