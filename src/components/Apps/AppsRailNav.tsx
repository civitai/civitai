import { Text, Tooltip } from '@mantine/core';
import clsx from 'clsx';
import React from 'react';
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
 */
export function AppsRailNavView({
  sections,
  currentPath,
  collapsed = false,
  onNavigate,
  className,
}: {
  sections: AppsSection[];
  currentPath: string;
  /** Icon-only mode. Ignored by the mobile drawer, which is always full-width. */
  collapsed?: boolean;
  /** Called when an entry is followed — the drawer uses it to close itself. */
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    <nav aria-label="App sections" className={clsx('flex flex-col gap-0.5', className)}>
      {appsSectionGroups.map((group) => {
        const inGroup = sections.filter((section) => section.group === group.id);
        if (!inGroup.length) return null;
        return (
          <React.Fragment key={group.id}>
            {/* 🔴 THE HEADING IS HIDDEN WHEN COLLAPSED, NOT REMOVED FROM THE TREE.
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
                wrapper, or a `<ul>`/`<li>` list — a markup change, not a comment change. */}
            <Text
              size="xs"
              fw={600}
              c="dimmed"
              tt="uppercase"
              px="sm"
              pt="sm"
              pb={4}
              className={collapsed ? 'sr-only' : undefined}
            >
              {group.label}
            </Text>
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
