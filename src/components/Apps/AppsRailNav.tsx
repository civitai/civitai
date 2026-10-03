import { Group, Text, Tooltip } from '@mantine/core';
import clsx from 'clsx';
import React, { type ReactNode } from 'react';
import type { AppsSection } from '~/components/Apps/apps-sections';
import {
  appsSectionGroups,
  getAppsSectionHref,
  isActiveAppsRoute,
} from '~/components/Apps/apps-sections';
import { NextLink } from '~/components/NextLink/NextLink';

/**
 * The `/apps/*` LEFT RAIL — presentational only. Takes the resolved section list, so it
 * can be rendered in isolation (props-only) under test and reused by the mobile drawer.
 *
 * 🔴 IT IS A `<nav aria-label="App sections">` LANDMARK CARRYING REAL ANCHORS, AND BOTH
 * HALVES ARE CARRIED OVER DELIBERATELY FROM THE TAB STRIP THIS REPLACED. The strip was
 * a Mantine `Tabs` wrapped in the same landmark, and its docstring recorded why:
 *
 *   • THE LANDMARK. This is cross-page navigation, not a single-page tab panel, so the
 *     navigation landmark — not a bare `role="tablist"` — is the correct semantics. A
 *     rail makes that easier rather than harder: there is no tablist any more, so the
 *     `<nav>` + `<a href>` tree is the whole story and nothing has to be talked out of
 *     announcing itself as a tab.
 *   • THE ANCHORS. Every entry is a real `<a href>` (`NextLink`), so keyboard,
 *     middle-click, open-in-new-tab and SEO affordances all survive. Navigation is the
 *     anchor's job; there is no `onChange` and no click handler — the route is the
 *     single source of truth, so following the link is what lights the new entry.
 *   • AND THE THING `activateTabWithKeyboard={false}` EXISTED TO BUY. Mantine's `Tabs`
 *     default arrow-key handler synthesises a `.click()` on the focused tab, which on
 *     these real anchors triggered a FULL PAGE NAVIGATION — so a keyboard user could not
 *     arrow through the nav to read it without being yanked to another page. The strip
 *     had to switch that off. A plain list of anchors has no roving-tabindex handler at
 *     all: Tab moves focus, Enter follows, and nothing navigates on focus. The defect is
 *     structurally absent here rather than suppressed by a prop, which is why no
 *     equivalent prop appears below.
 *
 * The `< 2 sections ⇒ no nav` collapse is NOT decided here — `AppsPageLayout` decides
 * it, because it also has to stop reserving the rail's 276px of horizontal chrome. See
 * `useAppsNavSections` for the rule and the cohort it still fires for.
 *
 * 🔴 THE COLLAPSE TOGGLE IS A PROP (`headerAction`), NOT SOMETHING THIS COMPONENT OWNS,
 * AND THAT IS WHAT KEEPS IT OUT OF THE MOBILE DRAWER. `AppsPageLayout` renders this
 * component TWICE — once in the desktop rail and once inside the narrow-screen `Drawer`,
 * which is always full width and therefore has nothing to collapse. An unconditional
 * toggle in here would appear in both; a `collapsed`-style boolean would be a second
 * place deciding the same thing. Passing the control in means the drawer gets no toggle
 * by CONSTRUCTION — the layout simply does not hand it one — rather than by a condition
 * someone can invert. Pinned in `AppsRailHeaderRow.geometry.test.tsx`.
 */
export function AppsRailNavView({
  sections,
  currentPath,
  collapsed = false,
  onNavigate,
  headerAction,
  className,
}: {
  sections: AppsSection[];
  currentPath: string;
  /** Icon-only mode. Ignored by the mobile drawer, which is always full-width. */
  collapsed?: boolean;
  /** Called when an entry is followed — the drawer uses it to close itself. */
  onNavigate?: () => void;
  /**
   * A control rendered on the FIRST group heading's row, right-aligned beside it (and
   * centred in its place when `collapsed`, where the heading is visually clipped).
   *
   * The rail's collapse toggle is the only caller. Omit it — as the mobile drawer does —
   * and the heading row is byte-identical to a rail with no action at all.
   */
  headerAction?: ReactNode;
  className?: string;
}) {
  /**
   * The groups that actually have sections, in registry order.
   *
   * Resolved BEFORE the render rather than skipped inside it, so `headerAction` can go on
   * the first group that RENDERS rather than on `appsSectionGroups[0]`. ⚠️ THOSE TWO
   * CANNOT DISAGREE TODAY, AND AN EARLIER VERSION OF THIS COMMENT CLAIMED THEY COULD —
   * it offered "a moderator-only viewer's first rendered group is `Moderate`", and that
   * viewer does not exist: `useAppsNavSections` returns `[]` outright without store
   * access, and Marketplace's only predicate is that same `canSeeStore`, so whenever
   * `sections` is non-empty the `discover` group renders. The real reason to key on the
   * rendered list is that it states the intent ("beside the first heading the viewer
   * sees") instead of coupling the action to the registry's declaration order — a
   * property that survives a reorder or a future ungated group. It is not guarding a
   * reachable cohort, and no test pretends otherwise.
   *
   * Non-empty whenever `sections` is: `AppsSection['group']` is `AppsSectionGroupId`,
   * derived from `appsSectionGroups` itself, so every section's group matches a row here
   * by construction. There is deliberately no runtime fallback for "an action with no
   * group to put it on" — it would be an untestable branch guarding a state the type
   * system already forbids. 🔴 The one thing that would make it reachable, and therefore
   * the trigger to watch: a section whose `group` comes from DATA rather than from the
   * registry. The collapse state is global and survives navigation, so a toggle rendered
   * nowhere would leave a collapsed rail with no way to re-expand it on any `/apps/*`
   * route.
   */
  const groups = appsSectionGroups
    .map((group) => ({
      group,
      inGroup: sections.filter((section) => section.group === group.id),
    }))
    .filter(({ inGroup }) => inGroup.length > 0);

  return (
    <nav aria-label="App sections" className={clsx('flex flex-col gap-0.5', className)}>
      {groups.map(({ group, inGroup }, index) => {
        /* 🔴 THE HEADING IS HIDDEN WHEN COLLAPSED, NOT REMOVED FROM THE TREE.
           `aria-hidden` + `hidden` would drop it from the accessibility tree too;
           a 56px rail has no room for the word, so it is visually clipped
           (`sr-only`) instead and stays announceable.

           ⚠️ IT IS ADJACENT TEXT, NOT A PROGRAMMATIC GROUP, and an earlier revision
           of this comment claimed the stronger thing ("a screen reader still wants
           the grouping"). There is no `role="group"`, no `aria-labelledby` tying the
           links to this heading, and no list wrapping them — they are loose anchors
           that happen to follow a `<Text>`. A screen reader announces the heading
           when the user reaches it and announces each link separately; nothing
           associates the two. That is a defensible choice for a six-row rail, but
           the association is NOT delivered, so do not cite this as grouping
           semantics. Making it real means `role="group"` + `aria-labelledby` on a
           wrapper, or a `<ul>`/`<li>` list — a markup change, not a comment change.

           🔴 THE PADDING STAYS ON THE `Text`, NOT ON THE ROW BELOW IT. `sr-only` sets
           `position: absolute; padding: 0`, so a collapsed heading contributes NO box
           at all — which is what keeps the collapsed rail's groups flush. Hoisting
           `pt`/`pb` onto the row would survive the clip and re-add 16px per group in
           exactly the state that has the least room for it. */
        const heading = (
          <Text
            size="xs"
            fw={600}
            c="dimmed"
            tt="uppercase"
            px="sm"
            pt="sm"
            pb={4}
            className={collapsed ? 'sr-only' : undefined}
            /* A stable hook for the suites that read the headings. They used to take
               "every non-anchor child of the nav", which stopped naming the heading the
               moment the first one gained a row wrapper for the collapse toggle — and
               `className` assertions about `sr-only` then read the WRAPPER's class. */
            data-apps-chrome="rail-group-heading"
          >
            {group.label}
          </Text>
        );
        const action = index === 0 ? headerAction : undefined;
        return (
          <React.Fragment key={group.id}>
            {action ? (
              /* 🔴 ONE ROW, NOT TWO. The action used to sit in its own `Group` ABOVE this
                 nav, so the rail opened with a 32px band of toggle and then a heading
                 under it. Sharing the heading's row reclaims that band. `Group` (Mantine)
                 rather than a Tailwind `flex` pair on purpose: the component-tier test
                 harness loads Mantine's stylesheet and NO Tailwind, so a utility-driven
                 row would compute `display: block` there and the "they are on one row"
                 measurement would read a stacked layout as correct.

                 Collapsed: the heading is out of flow (see above), so `center` centres
                 the action alone — and `pr` goes to 0 so it is centred on the rail rather
                 than 12px off it. */
              <Group
                justify={collapsed ? 'center' : 'space-between'}
                align="center"
                wrap="nowrap"
                gap={0}
                pr={collapsed ? 0 : 'sm'}
                data-apps-chrome="rail-group-header"
              >
                {heading}
                {action}
              </Group>
            ) : (
              heading
            )}
            {inGroup.map((section) => (
              <AppsRailLink
                key={section.id}
                section={section}
                active={isActiveAppsRoute(getAppsSectionHref(section), currentPath)}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            ))}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

function AppsRailLink({
  section,
  active,
  collapsed,
  onNavigate,
}: {
  section: AppsSection;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = section.icon;
  const link = (
    <NextLink
      href={getAppsSectionHref(section)}
      onClick={onNavigate}
      className={clsx(
        'flex items-center rounded py-2 text-sm no-underline transition-colors',
        collapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
        active
          ? 'bg-blue-1 font-semibold text-dark-9 dark:bg-blue-8/25 dark:text-white'
          : 'font-medium text-dark-7 hover:bg-gray-1 dark:text-gray-4 dark:hover:bg-dark-5'
      )}
      // 🔴 THE ACCESSIBLE NAME SURVIVES THE COLLAPSE. With the label visually hidden the
      // anchor would otherwise be named by its icon alone, i.e. by nothing — so the
      // label is re-attached as `aria-label`. Not `title`: a title is not announced
      // reliably and duplicates the tooltip below.
      aria-label={collapsed ? section.label : undefined}
      aria-current={active ? 'page' : undefined}
    >
      <Icon size={18} className={active ? 'text-blue-6' : 'text-gray-6 dark:text-dark-2'} />
      {!collapsed && <span className="flex-1">{section.label}</span>}
    </NextLink>
  );

  if (!collapsed) return link;
  return (
    <Tooltip label={section.label} position="right" openDelay={300} withinPortal>
      {link}
    </Tooltip>
  );
}
