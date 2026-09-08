import { Group, Paper, Skeleton, Stack, Text } from '@mantine/core';

/**
 * `/apps/build`'s LOADING state — the window where the page knows the viewer is an
 * author but does not yet know whether they have apps.
 *
 * 🔴 WHAT THIS FIXES, AND IT IS A CORRECTNESS BUG RATHER THAN POLISH. `blocks.getNavSummary`
 * decides state B (`first-app`) vs state C (`workbench`), and it is client-only (tRPC runs
 * `ssr: false`). `resolveAppsBuildState` returns `first-app` whenever both of its summary
 * booleans are false — which is what an unresolved query looks like — so before this
 * component existed EVERY author who has apps rendered "Ship your first app" on the server
 * and on the first client paint, and swapped to their workbench once the query landed.
 * They were shown the wrong screen, briefly, on every visit. A spinner would not fix that;
 * a state that asserts nothing about which screen is coming does.
 *
 * 🔴 SO THE DESIGN CONSTRAINT IS NEUTRALITY, NOT PARITY. The destination is unknown by
 * construction while this renders, so this must not look like either B or C — it reserves a
 * plausible block and nothing more. Do NOT "improve" it into a pixel-copy of the workbench
 * table: that would be the same defect one screen over, guessing C for an author headed to B.
 *
 * ⚠️ WHAT IT DOES **NOT** CLAIM. Not zero layout shift. The block below settles to either a
 * short empty-state or a paginated table, and no reservation can be right about both. The
 * claim is only that no state-B *content* is shown to an author who is not in state B.
 * (Contrast `AppListingCardSkeleton`, which DOES claim per-card geometry parity — it knows
 * exactly what it is reserving for. This one structurally cannot, so it does not say so.)
 *
 * Visual language is shared with that component (Mantine `Skeleton` bars over real line
 * boxes, `role="status"` + sr-only text on the container, decorative bars `aria-hidden`);
 * the work is deliberately separate — see clawgate #500, which owns the STORE GRID's
 * skeletons.
 */

/**
 * A skeleton bar shaped like ONE line of real text at a given Mantine `size`.
 *
 * 🔴 THE `<Text>` IS THE MEASUREMENT, NOT DECORATION — the same technique as
 * `AppListingCardSkeleton`'s `MetaLineSkeleton`, and duplicated rather than shared
 * because that one is tuned to the store card's reservation and this one is not
 * reserving anything specific. Its content is a non-breaking space, so the element's
 * line box is whatever a real `<Text size={size}>` would produce under the current theme
 * tokens; the visible bar is an ABSOLUTELY positioned `Skeleton` over it, out of flow, so
 * it contributes no height of its own. A bar with a hand-picked pixel height would be a
 * second copy of Mantine's type scale.
 *
 * 🔴 `component="span"` ON THE SKELETON IS THE ONLY REASON THIS IS VALID HTML. Mantine's
 * `Text` renders a `<p>` and its `Skeleton` a `<div>`; a `<div>` may not descend from a
 * `<p>`, so the parser auto-closes the `<p>` and React's tree stops matching the parsed
 * DOM — a hydration mismatch on every render of this component. (That exact bug shipped
 * once in the store skeleton; see the note there.)
 */
function TextLineSkeleton({ size, widthPct }: { size: 'sm' | 'xs'; widthPct: number }) {
  return (
    <Text size={size} c="dimmed" style={{ position: 'relative' }}>
      {/* A NON-BREAKING SPACE, not a plain one: whitespace-only text collapses and can
          leave the element with no line box at all, i.e. no reservation. Written as an
          escape so it is visible in a diff. */}
      {'\u00A0'}
      <Skeleton
        component="span"
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${widthPct}%` }}
      />
    </Text>
  );
}

/** How many row bars the reserved block holds. Enough to read as a list, few enough that
 *  settling to a short empty-state is not a large collapse. Not an estimate of a result
 *  count — see the "does not claim zero layout shift" note above. */
const APPS_BUILD_SKELETON_ROWS = 4;

export function AppsBuildBodySkeleton() {
  return (
    <Stack gap="lg" data-testid="apps-build-skeleton" role="status">
      {/* The live region announces its CONTENT, so the announceable text is real text
          inside it and every decorative bar below is `aria-hidden`. No `aria-busy`: on a
          live region that is the standard instruction to WITHHOLD announcements, and this
          region unmounts rather than clearing, so it could never flip back to false.
          ⚠️ Not verified with a screen reader — the claim is that the markup CAN announce. */}
      <span className="sr-only">Loading your apps</span>

      {/* The header row, mirroring the workbench's subtitle + `New app` button so the
          block above the fold does not jump sideways when the state resolves to C. */}
      <Group justify="space-between" align="center" wrap="wrap" aria-hidden>
        <div style={{ flexGrow: 1, minWidth: 0, maxWidth: 520 }}>
          <TextLineSkeleton size="sm" widthPct={100} />
        </div>
        {/* Sized like a Mantine default-size `Button`: 36px tall. Width is nominal —
            the real button's is set by its label, which is not worth a constant. */}
        <Skeleton height={36} width={116} radius="sm" />
      </Group>

      <Paper withBorder p="md" radius="sm" aria-hidden>
        <Stack gap="sm">
          {Array.from({ length: APPS_BUILD_SKELETON_ROWS }, (_, i) => (
            <TextLineSkeleton
              key={i}
              size="sm"
              // Cosmetic only: a ragged last row reads as a list rather than a block.
              // No geometry depends on it.
              widthPct={i === APPS_BUILD_SKELETON_ROWS - 1 ? 46 : 100}
            />
          ))}
        </Stack>
      </Paper>
    </Stack>
  );
}
