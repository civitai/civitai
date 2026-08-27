import { Box, Container, Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { AppsSubNav } from '~/components/Apps/AppsSubNav';
import { APPS_PAGE_CONTAINER_WIDTH } from '~/components/Apps/appsPageWidths';

/**
 * Shared chrome for every `/apps/*` surface.
 *
 * THE POINT: the {@link AppsSubNav} tabs must sit in the IDENTICAL position on
 * every apps page — VERTICALLY *and* HORIZONTALLY. Before this, each page
 * hand-rolled its own `Container size=… py=…` + a per-page title block placed
 * ABOVE or AROUND the sub-nav, so the tabs jumped around as you navigated between
 * surfaces. This layout fixes the tabs as the FIRST element of the page header
 * region — so they land in the same vertical position every time — and renders the
 * optional per-page title/actions BELOW them. (No sticky positioning: the
 * requirement is a CONSISTENT position across pages, which the uniform "tabs
 * first" order already delivers; pinning the band on scroll risks colliding with
 * the global app-shell header and was unverified.)
 *
 * 🔴 THE HORIZONTAL HALF IS WHY THERE IS NO `size` PROP. This layout used to take a
 * per-page container width, which put the SHARED chrome inside a PER-PAGE box: the
 * tab strip inherited each page's width and moved horizontally between routes
 * (measured 170px of left-edge spread at 1440 and 410px at 2560 — the numbers are
 * in `appsPageWidths.ts`). The Container is now {@link APPS_PAGE_CONTAINER_WIDTH}
 * on every route, and the narrowing some pages genuinely need is the `measure`
 * prop below, which constrains the BODY only — below the chrome, not around it.
 * Re-adding a container-width prop re-opens the defect; both halves are pinned in
 * `__tests__/appsPageLayout.test.ts` and
 * `AppsPageLayout.chromeAlignment.browser.test.tsx`.
 *
 * Each page wraps its body in `<AppsPageLayout …>{body}</AppsPageLayout>`,
 * dropping its own `Container` + ad-hoc sub-nav placement. The per-page title,
 * subtitle and right-aligned header actions become props so the header geometry
 * is uniform; only the content slot differs.
 *
 * Flag-gating + any per-page access redirect stay on the page
 * (`getServerSideProps` / the in-component `NotFound` guard) — this layout is
 * presentational chrome only and assumes the page already passed its gate.
 *
 * Which flag depends on the surface, and the two are NOT interchangeable: the
 * STORE surfaces (`/apps`, `/apps/store-preview/<slug>`) gate on the shared
 * `hasAppsStoreAccess` predicate (`appListings || appBlocks`), while the block-
 * RUNTIME surfaces (`/apps/installed`, `/apps/review`, `/apps/my-submissions`,
 * `/apps/revenue`) gate on `appBlocks` alone because they need the runtime, not
 * just the catalog.
 */
export function AppsPageLayout({
  title,
  subtitle,
  actions,
  measure,
  children,
}: {
  /** Page heading (omit for a header with just the tabs, e.g. the marketplace). */
  title?: ReactNode;
  /** Optional dimmed sub-heading rendered under the title. */
  subtitle?: ReactNode;
  /** Right-aligned header controls (e.g. a "Submit a new app" button). */
  actions?: ReactNode;
  /**
   * Optional CONTENT measure (px) for the page BODY — a max-width applied BELOW the
   * chrome, never around it. Omit it and the body fills the container.
   *
   * 🔴 LEFT-ALIGNED, NOT CENTRED, and that is load-bearing rather than taste: a
   * centred body would put its left edge at a different x on every route, which is
   * the same defect as the per-page container one level out — the page content
   * would stop lining up with the tab strip directly above it. The parent `Stack`
   * is a column flexbox with the default `align="stretch"`, so a `maw` alone
   * resolves to a left-aligned capped box; no auto margins, and nothing here may
   * introduce `margin-inline: auto`.
   *
   * Values come from `APPS_PAGE_MEASURES` in `~/components/Apps/appsPageWidths` —
   * they are CONTENT widths (the old container widths minus the `Container`'s own
   * `2 × 16px` gutter), because this box sits INSIDE that gutter.
   */
  measure?: number;
  children: ReactNode;
}) {
  const hasHeader = Boolean(title || subtitle || actions);
  // `pb` only — NO `py`. The top pad is deliberately gone so `/apps/*` starts
  // directly under the global header instead of 16px below it; the BOTTOM pad
  // stays because this Container is the outermost element on every apps page, so
  // its `pb` is the only thing keeping the last grid row / table row off whatever
  // follows. Horizontal padding is untouched (Container's own responsive gutter).
  return (
    <Container size={APPS_PAGE_CONTAINER_WIDTH} pb="md">
      {/* `xl` (32px), not `lg` (20px). With the band's own rule removed, the ONLY
          thing telling a viewer where the header ends and the page begins is the
          size of this gap relative to the `md` (16px) gap INSIDE the band. At
          `lg` that contrast was 20 vs 16 — measured off a render, four pixels,
          which is not a grouping anyone perceives. `xl` makes it 32 vs 16, a
          clean 2:1, and the header reads as a band again without a second line.
          (Checked against a 1440 render of the `hasHeader` layout, not inferred
          from the tokens: the Title's own line box eats part of the nominal gap,
          so the token difference alone overstated the visual one.) */}
      <Stack gap="xl">
        {/*
          Page header region. The sub-nav tabs are the FIRST child here and
          carry no leading content, so they land in the same spot on every page
          regardless of whether a per-page title is present. The title/actions
          render BELOW the tabs (never above), which is what keeps the tabs from
          shifting vertically between surfaces.
        */}
        {/*
          🔴 NO `borderBottom` here — that was a DOUBLE RULE. Mantine's
          `Tabs.List` (inside `AppsSubNav`) already draws its own bottom border,
          so this band's hairline landed ~8px below it and every `/apps` page
          rendered two parallel lines under the tabs. The tabs' own border is the
          separator; this band contributes SPACING only.

          SPACING after removing it — the second-order effect is on the
          `hasHeader` pages (`installed`, `my-submissions`, `revenue`, `review`,
          `review/[id]`, `submit`), where the title/subtitle/actions render BELOW
          the tabs INSIDE this band. There the removed rule was also the only
          thing separating the title from the page content, so dropping it alone
          would leave the title floating between the tab border and the body.
          The band is therefore held together by PROXIMITY instead of a rule:
            - NO vertical padding of its own (was `pt="sm"`, and `py="sm"` before
              that). 🔴 Neither pad ever participated in the grouping: `pt` sits
              ABOVE the tabs, i.e. OUTSIDE the tabs↔title relationship entirely,
              so it only pushed the whole band down the page. `pb` was already
              removed because it DID matter — it sat between the title and the
              body and made the title equidistant. Dropping `pt` therefore moves
              the band up without touching what holds it together; measured on a
              1440 render, the two gaps below are byte-identical before and after
              (16px / 32px).
            - `gap="md"` (16px) INSIDE the band, vs the parent `Stack gap="xl"`
              (32px) from the band to the content — the title is measurably
              closer to the tabs than to the body, which is what makes them read
              as one unit without a second line. (See the note on that parent
              Stack for why `lg` was not enough.) 🔴 THIS PAIR IS THE GROUPING.
              Change either number and the title starts floating; the vertical
              padding around the band is free to move, these two are not.
          A no-header page (the store) is unaffected apart from losing the
          duplicate rule.
        */}
        <Stack gap="md">
          <AppsSubNav />
          {hasHeader && (
            <Group justify="space-between" align="flex-end" wrap="nowrap" gap="md">
              <Stack gap={4} style={{ minWidth: 0 }}>
                {title && <Title order={2}>{title}</Title>}
                {subtitle && (
                  <Text c="dimmed" size="sm">
                    {subtitle}
                  </Text>
                )}
              </Stack>
              {actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
            </Group>
          )}
        </Stack>

        {/*
          The BODY, optionally capped. 🔴 THE CAP IS HERE, INSIDE THE `Stack gap="xl"`,
          AND NOT ONE LEVEL OUT — that placement is the entire fix. A narrower box
          around the whole `Stack` would take the sub-nav with it, which is exactly
          what the per-page `Container size=` used to do. Wrapping only `{children}`
          leaves the chrome on the uniform container while still letting a form page
          hold a readable measure.

          Rendered UNWRAPPED when there is no measure, rather than as a `<Box>` with
          no `maw`: the full-container pages are the majority, and an always-present
          wrapper is a DOM node the vertical-geometry pins would have to be re-derived
          against for no benefit.
        */}
        {measure != null ? <Box maw={measure}>{children}</Box> : children}
      </Stack>
    </Container>
  );
}
