import { Box, Button, Container, Drawer, Group, Stack, Text, Title, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMenu2,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, type ReactNode } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { APPS_NAV_MIN_SECTIONS } from '~/components/Apps/apps-sections';
import { AppsRailNavView } from '~/components/Apps/AppsRailNav';
import classes from '~/components/Apps/AppsPageLayout.module.scss';
import {
  APPS_RAIL_COLLAPSED_WIDTH,
  APPS_RAIL_MIN_VIEWPORT,
  APPS_RAIL_WIDTH,
  useAppsRail,
} from '~/components/Apps/appsRailState';
import { useAppsNavSections } from '~/components/Apps/useAppsNavSections';
import {
  APPS_PAGE_CONTAINER_WIDTH,
  appsMeasureCss,
  type AppsMeasure,
} from '~/components/Apps/appsPageWidths';
import { SUBNAV_STICKY_GAP, useSubnavBottom } from '~/hooks/useSubnavBottom';

/**
 * Shared chrome for every `/apps/*` surface.
 *
 * 🔴 THE SECOND HORIZONTAL NAV IS GONE. `/apps/*` used to render TWO stacked horizontal
 * bars: the global `SubNav2` pill strip (`~/components/AppLayout/SubNav`, which already
 * carries an "Apps" pill) and then, directly beneath it, this layout's own
 * `AppsSubNav` tab strip. Two full-width rules, one under the other, on every apps page.
 * The second one is now a VERTICAL LEFT RAIL, following the two in-repo precedents:
 * `~/components/Account/AccountLayout` (the section-registry + rail pattern) and
 * `~/components/Collections/CollectionsLayout` (a collapsible sticky rail with a gutter
 * toggle and a mobile `Drawer`, on a wide, grid-bearing page).
 *
 * THE POINT, UNCHANGED: the nav must sit in the IDENTICAL position on every apps page —
 * VERTICALLY *and* HORIZONTALLY. Before this layout existed, each page hand-rolled its
 * own `Container size=… py=…` + a per-page title block, so the nav jumped around as you
 * navigated. The rail is the FIRST element of the page row on every route and the
 * optional per-page title/actions render inside the body column beside it.
 *
 * 🔴 THE HORIZONTAL HALF IS WHY THERE IS NO `size` PROP. This layout used to take a
 * per-page container width, which put the SHARED chrome inside a PER-PAGE box: the nav
 * inherited each page's width and moved horizontally between routes (measured 170px of
 * left-edge spread at 1440 and 410px at 2560 — the numbers are in `appsPageWidths.ts`).
 * The Container is {@link APPS_PAGE_CONTAINER_WIDTH} on every route, and the narrowing
 * some pages genuinely need is the `measure` prop below, which constrains the BODY only
 * — inside the body column, never around the rail. Re-adding a container-width prop
 * re-opens the defect; both halves are pinned in `__tests__/appsPageLayout.test.ts` and
 * `AppsPageLayout.chromeAlignment.browser.test.tsx`.
 *
 * 🔴 THE COLLAPSE STATE IS ONE GLOBAL VALUE, NOT ONE PER ROUTE. It lives in
 * `AppsRailProvider`, mounted in `_app` ABOVE the router outlet, because this component
 * is unmounted and remounted on every navigation. A per-route default would re-open the
 * rail on every click and would break the 12-route alignment ledger by design. See
 * `appsRailState.tsx`.
 *
 * Flag-gating + any per-page access redirect stay on the page
 * (`getServerSideProps` / the in-component `NotFound` guard) — this layout is
 * presentational chrome only and assumes the page already passed its gate.
 */
export function AppsPageLayout({
  title,
  subtitle,
  actions,
  measure,
  children,
}: {
  /** Page heading (omit for a header with just the chrome, e.g. the marketplace). */
  title?: ReactNode;
  /** Optional dimmed sub-heading rendered under the title. */
  subtitle?: ReactNode;
  /** Right-aligned header controls (e.g. a "Submit a new app" button). */
  actions?: ReactNode;
  /**
   * Optional CONTENT measure (px) for the page's OWN content — the header band's
   * title/subtitle/actions AND the body. Applied inside the body column, never around
   * the rail. Omit it and the content fills the column.
   *
   * 🔴 IT BOUNDS THE HEADER TOO, and that is not symmetry for its own sake. The nav is
   * the only thing this layout is allowed to move; if the measure bounded the body
   * alone, a measured page's header PROSE would stretch to the full column while its
   * body stayed narrow. Measured on a real render with the live `/apps/submit` subtitle
   * copy: the subtitle laid out at 1224.13px where before it could never exceed 1068.
   * Bounding both is what makes "only the chrome moved" a true statement rather than an
   * aspiration. It also closes a latent trap by construction: `actions` is right-aligned
   * by `Group justify="space-between"`, so against the COLUMN the first measured page to
   * add a header button would have put it hundreds of px right of the body it acts on.
   *
   * ⚠️ A BAND'S RAMP NOW RESOLVES AGAINST THE BODY COLUMN, NOT THE CONTAINER, AND THAT
   * NARROWS THE MEASURED ROUTES ON A WIDE SCREEN. The middle term of
   * `appsMeasureCss`'s `clamp()` is a PERCENTAGE, and a percentage `max-width` resolves
   * against the containing block — which the rail has just made 276px narrower. So
   * `/apps/submit` at a 2560 viewport lands at ~1238px instead of its 1368 ceiling.
   * Nothing moves at 1440 or 1920, where both bands are pinned to their `min` floor
   * anyway. This is the correct direction (the page really does have less room) and it
   * is stated here rather than discovered: it is the one geometry change on the measured
   * routes that is NOT the rail's own width.
   *
   * 🔴 LEFT-ALIGNED, NOT CENTRED, and that is load-bearing rather than taste: a
   * centred body would put its left edge at a different x on every route, which is
   * the same defect as the per-page container one level out — the page content
   * would stop lining up with the rail beside it. The body column's `Stack` is a
   * column flexbox with the default `align="stretch"`, so a `maw` alone resolves to a
   * left-aligned capped box; no auto margins, and nothing here may introduce
   * `margin-inline: auto`.
   */
  measure?: AppsMeasure;
  children: ReactNode;
}) {
  const router = useRouter();
  const sections = useAppsNavSections();
  const { collapsed, toggle } = useAppsRail();
  const subnavBottom = useSubnavBottom();
  const [drawerOpened, drawer] = useDisclosure(false);

  /**
   * 🔴 CLOSE THE DRAWER WHEN THE RAIL TAKES OVER. The rail/drawer swap is a CSS media
   * query (see the stylesheet), so React never learns the breakpoint was crossed —
   * meaning an OPEN drawer stays open when the viewport widens past
   * `APPS_RAIL_MIN_VIEWPORT`. The result is both `<nav aria-label="App sections">`
   * landmarks exposed at once, with the drawer's focus trap and overlay sitting over a
   * fully usable rail. Reachable by rotating a tablet or dragging a window wider.
   *
   * 🔴 THIS IS THE ONE PLACE A MEDIA QUERY IS READ IN JS, AND IT IS NOT THE SWAP. It runs
   * only in an EFFECT and only ever CLOSES something — it can never decide what to
   * render, so it cannot reintroduce the SSR/first-paint divergence the stylesheet exists
   * to avoid. `matchMedia` is absent during SSR and the effect does not run there; a
   * browser without `addEventListener` on the list falls through harmlessly.
   */
  useEffect(() => {
    if (!drawerOpened || typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(`(min-width: ${APPS_RAIL_MIN_VIEWPORT}px)`);
    if (mql.matches) {
      drawer.close();
      return;
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) drawer.close();
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
    // 🔴 `drawer.close`, NOT `drawer`. Mantine's `useDisclosure` returns a FRESH OBJECT
    // LITERAL on every render, and `toggle`'s identity also moves with `opened` — so
    // `[drawerOpened, drawer]` re-runs this on every render of the layout, which
    // `useSubnavBottom` triggers on every scroll. Nothing leaked (the cleanup is correct)
    // but it was a `removeEventListener` + `matchMedia()` + `addEventListener` per frame
    // while the drawer was open. `close` is the one member that IS stable
    // (`useCallback([onClose])`), and it is the only one this effect uses.
  }, [drawerOpened, drawer.close]);

  /**
   * 🔴 THE `< 2 SECTIONS ⇒ NO NAV` COLLAPSE, CARRIED OVER FROM THE TAB STRIP AND
   * RESTATED FOR A RAIL: no rail, and the body takes the FULL container.
   *
   * A single-entry "navigation" can only link to the page you are already on. As a tab
   * strip that cost a row's height; as a rail it would cost 276px of every apps page's
   * width, which is strictly worse. It still fires for the same live cohort: a
   * store-visible non-author with no installs and no `appBlocksGetStarted` qualifies for
   * Marketplace alone.
   *
   * 🔴 IT IS ALSO A POST-HYDRATION RELAYOUT, AND THAT COST IS NEW WITH THE RAIL. The
   * summary-driven sections are deferred behind `useIsClient()` (see `useAppsNavSections`
   * for the incident that requires it), so a store-visible NON-AUTHOR WITH INSTALLS —
   * anyone who has ever installed an app — renders `[Marketplace]` alone on the server and
   * the first client paint, falls BELOW this floor, and gets no rail. After mount
   * `Activity` appears, the count reaches two, and the rail mounts: the body moves 276px
   * right and the container-queried store grid beneath it re-ladders.
   *
   * Server and first paint still agree exactly — this is not a hydration mismatch, and the
   * deferral is not the defect. What changed is the PRICE of the reveal: as a tab strip it
   * cost one ROW of vertical chrome; as a rail it is a full-width horizontal relayout on
   * the commonest cohort.
   *
   * 🔴 THE ALTERNATIVE IS NOT FREE, WHICH IS WHY THIS IS LEFT AS IT IS AND FLAGGED RATHER
   * THAN QUIETLY CHANGED. Reserving the rail from the first paint for any logged-in store
   * viewer whose summary query will run uses only SSR-safe inputs and would remove the
   * shift — but it hands the genuinely-one-section cohort 276px of permanent chrome around
   * a single link, which is the exact waste this floor exists to prevent. Deferring, as
   * now, charges that cohort nothing and charges the common one a one-time shift.
   * A product call, not an engineering one; raised on the PR. The current behaviour is
   * pinned in `AppsRailNav.hydration.browser.test.tsx` so the choice is visible in a diff.
   */
  const hasRail = sections.length >= APPS_NAV_MIN_SECTIONS;
  const hasHeader = Boolean(title || subtitle || actions);

  /**
   * Cap `node` at the page's measure, or hand it back untouched when there is none.
   *
   * 🔴 ONE HELPER, TWO CALL SITES, so the header band and the body cannot drift apart —
   * a second copy of this conditional is exactly how they would end up with different
   * left and right edges. It never wraps the rail: the chrome is in a different column
   * entirely, which is the strongest form the original fix can take.
   *
   * No auto margins, deliberately. The body column's `Stack` is a column flexbox with
   * the default `align="stretch"`, so a bare `maw` resolves LEFT-ALIGNED; anything that
   * re-centres it puts each route's content at a different x and re-creates the defect
   * one level down. Pinned structurally in `__tests__/appsPageLayoutRender.test.ts` and
   * on resolved geometry in `AppsPageLayout.chromeAlignment.browser.test.tsx`.
   */
  const bounded = (node: ReactNode) =>
    measure != null ? <Box maw={appsMeasureCss(measure)}>{node}</Box> : node;

  // `pb` only — NO `py`. The top pad is deliberately gone so `/apps/*` starts
  // directly under the global header instead of 16px below it; the BOTTOM pad
  // stays because this Container is the outermost element on every apps page, so
  // its `pb` is the only thing keeping the last grid row / table row off whatever
  // follows. Horizontal padding is untouched — Container's own gutter, a FLAT 16px per
  // side in Mantine v7 (there is no responsive step), which is why
  // `APPS_CONTAINER_GUTTER = 32` is right at every breakpoint, not only at wide ones.
  return (
    <Container size={APPS_PAGE_CONTAINER_WIDTH} pb="md">
      <div className={classes.railRow} data-apps-chrome="row">
        {hasRail && (
          <aside
            className={classes.rail}
            data-apps-chrome="rail"
            // The WIDTH is inline because the collapse state is React's, and the node
            // tier reads it off a rendered tree. Only the rail's PRESENCE (the ≥1300px
            // switch) lives in the stylesheet — see `AppsPageLayout.module.scss`.
            style={{ width: collapsed ? APPS_RAIL_COLLAPSED_WIDTH : APPS_RAIL_WIDTH }}
          >
            <div
              // Follows the subnav's real bottom edge rather than a fixed header offset:
              // the global subnav hides by TRANSLATING, so it keeps its layout box and a
              // static `top` strands the rail a subnav-height below where it should sit.
              // Both in-repo rail precedents (`AccountLayout`, `CollectionsLayout`) pin
              // to this same pair; do not substitute a constant.
              style={{ position: 'sticky', top: subnavBottom + SUBNAV_STICKY_GAP }}
            >
              <Group justify={collapsed ? 'center' : 'flex-end'} gap={0} mb={4}>
                <Tooltip
                  label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
                  position="right"
                  openDelay={300}
                >
                  <LegacyActionIcon
                    variant="subtle"
                    color="gray"
                    onClick={toggle}
                    aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? (
                      <IconLayoutSidebarLeftExpand size={18} />
                    ) : (
                      <IconLayoutSidebarLeftCollapse size={18} />
                    )}
                  </LegacyActionIcon>
                </Tooltip>
              </Group>
              {/* ⚠️ THE TOGGLE SITS INSIDE THE RAIL, NOT IN THE GUTTER — a deliberate
                  deviation from `CollectionsLayout`, which absolutely-positions its
                  toggle at `right: -32px`. That works there because the gutter it
                  overhangs is 8px of a card's margin; here the gap is 16px and the
                  button is 28px, so a gutter toggle would overlap the page body on every
                  route and would need `overflow: visible` maintained up the whole
                  ancestor chain (a hazard that file documents at length). An in-rail
                  toggle costs one row and cannot be clipped out of existence. */}
              <AppsRailNavView
                sections={sections}
                currentPath={router.pathname}
                collapsed={collapsed}
              />
            </div>
          </aside>
        )}

        {/* 🔴 THE BODY COLUMN'S GEOMETRY IS AN INLINE STYLE, NOT `flex-1 min-w-0`, AND
            THAT IS NOT A STYLE PREFERENCE. Tailwind utilities live in the UNLAYERED
            cascade that `_document`'s `@layer tailwind-preflight, theme, mantine, modules`
            declaration sits above, so they work in production — but they are a SEPARATE
            stylesheet from the layout's own CSS module, and anything that does not load
            it sees this column shrink to its content's intrinsic width. Measured: in the
            component harness (which loads `@mantine/core/styles.css` and the CSS modules,
            but no Tailwind) the body laid out at 34.7px — the width of the word "body" —
            on every route, so the alignment ledger was measuring a column production
            never renders. The two numbers this layout exists to guarantee are the rail's
            width and the body's; neither may depend on a stylesheet that can be absent.
            Presentation (colours, hover, spacing inside the rail) stays on utilities. */}
        <div style={{ flex: '1 1 0%', minWidth: 0 }} data-apps-chrome="body-column">
          {/* `xl` (32px), not `lg` (20px). The ONLY thing telling a viewer where the
              header ends and the page begins is the size of this gap relative to the
              `md` (16px) gap INSIDE the band. At `lg` that contrast was 20 vs 16 —
              measured off a render, four pixels, which is not a grouping anyone
              perceives. `xl` makes it 32 vs 16, a clean 2:1. */}
          <Stack gap="xl">
            {/*
              🔴 NO `borderBottom` here. It was once a DOUBLE RULE (Mantine's `Tabs.List`
              already drew its own bottom border, so this band's hairline landed ~8px
              below it). The tab strip is gone, so there is no second rule to duplicate —
              and the band still contributes SPACING only, because the grouping below is
              what holds it together:
                - NO vertical padding of its own. A `pb` would sit between the title and
                  the body and make the title equidistant, which is exactly the float a
                  rule-less band must not have.
                - `gap="md"` (16px) INSIDE the band, vs the parent `Stack gap="xl"`
                  (32px) from the band to the content — the title is measurably closer to
                  the drawer trigger above it than to the body below.
              🔴 THIS PAIR IS THE GROUPING. Change either number and the title starts
              floating; the vertical padding around the band is free to move, these two
              are not.
            */}
            <Stack gap="md" data-apps-chrome="band">
              {hasRail && (
                <div className={classes.railDrawerTrigger} data-apps-chrome="drawer-trigger">
                  <Button
                    variant="default"
                    size="compact-sm"
                    leftSection={<IconMenu2 size={16} />}
                    onClick={drawer.open}
                  >
                    App sections
                  </Button>
                </div>
              )}
              {hasHeader &&
                bounded(
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
              around the whole column would be a per-page width again; the rail is in a
              different column and can no longer be swept up by it at all.

              Rendered UNWRAPPED when there is no measure, rather than as a `<Box>` with
              no `maw`: the full-container pages are the majority, and an always-present
              wrapper is a DOM node the vertical-geometry pins would have to be re-derived
              against for no benefit.
            */}
            {bounded(children)}
          </Stack>
        </div>
      </div>

      {/*
        THE NARROW-SCREEN FORM. Below `APPS_RAIL_MIN_VIEWPORT` the rail is
        `display: none` and this drawer is the only route between apps pages — the same
        shape `CollectionsLayout` uses, and the same shape `AccountLayout` uses for its
        mobile index.

        It is rendered unconditionally (closed) rather than behind a media-query hook,
        for the reason written out on the stylesheet: a hook has no server answer, and a
        differing tree between the SSR render and the first client paint is the hydration
        mismatch this surface has already paid for once.
      */}
      {hasRail && (
        <Drawer
          opened={drawerOpened}
          onClose={drawer.close}
          size="xs"
          title="App sections"
          classNames={{ body: 'px-2' }}
        >
          <AppsRailNavView
            sections={sections}
            currentPath={router.pathname}
            onNavigate={drawer.close}
          />
        </Drawer>
      )}
    </Container>
  );
}
