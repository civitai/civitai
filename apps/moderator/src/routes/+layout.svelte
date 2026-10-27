<script lang="ts">
  import '../global.css';
  import { Toaster } from '@civitai/ui/components/ui/sonner/index.js';
  import { page, navigating } from '$app/state';
  import { toLinkBase } from '$lib/civitai-link';
  import { buildWordmarkSvg } from '@civitai/brand';
  import {
    IconLayoutDashboard,
    IconFlag,
    IconPhoto,
    IconArticle,
  IconBox,
    IconUsers,
    IconShieldLock,
    IconListSearch,
    IconScanLetterT,
    IconChartBar,
    IconScale,
    IconCircle,
    IconChevronRight,
    IconLogout,
  } from '@tabler/icons-svelte';
  import {
    Sidebar,
    SidebarProvider,
    SidebarHeader,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuButton,
    SidebarMenuSub,
    SidebarMenuSubItem,
    SidebarMenuSubButton,
    SidebarFooter,
    SidebarInset,
    SidebarTrigger,
  } from '@civitai/ui/components/ui/sidebar/index.js';
  import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
  } from '@civitai/ui/components/ui/collapsible/index.js';
  import { Avatar, AvatarImage, AvatarFallback } from '@civitai/ui/components/ui/avatar/index.js';
  import { getEdgeUrl } from '$lib/media/edge-url';
  import type { LayoutData } from './$types';
  import type { NavLink } from '$lib/server/access';
  import {
    isNavLinkActive,
    isPathActive,
    navBadge,
    navCount,
    navHref,
    navPartial,
    navWorstRank,
  } from '$lib/nav-links';
  import {
    sidebarCounts,
    sidebarLastActioned,
    sidebarQueueOldest,
    refreshSidebarCounts,
  } from '$lib/sidebar-counts.svelte';
  import {
    URGENT_SEVERITY_RANK,
    queueWaitBadge,
    severityClassForRank,
  } from '$lib/queue-thresholds';
  import ShortAge from '$lib/components/ShortAge.svelte';
  import { minuteClock } from '$lib/minute-clock.svelte';
  import UserCardPopover from '$lib/components/user-card/UserCardPopover.svelte';
  import QuickSwitcher from '$lib/components/QuickSwitcher.svelte';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  const wordmark = buildWordmarkSvg({ base: '#e8eaed' });

  const icons: Record<string, typeof IconLayoutDashboard> = {
    '/': IconLayoutDashboard,
    '/reports': IconFlag,
    '/images': IconPhoto,
    '/articles': IconArticle,
    '/models': IconBox,
    '/audit': IconListSearch,
    '/text-scan': IconScanLetterT,
    '/ratings': IconScale,
    '/admin': IconShieldLock,
    '/page-visits': IconChartBar,
  };
  const groupIcons: Record<string, typeof IconPhoto> = { Images: IconPhoto, Users: IconUsers };
  const iconFor = (item: NavLink) =>
    (item.path ? icons[item.path] : groupIcons[item.label]) ?? IconCircle;

  const counts = sidebarCounts();
  $effect(() => {
    page.url.pathname;
    refreshSidebarCounts();
  });
  const countFor = (key: string | undefined) =>
    key && counts.value ? (counts.value[key] ?? null) : null;
  const rollupFor = (item: NavLink) => (item.children ? navCount(item, countFor) || null : null);
  // A count the server could not read is marked, not left out: "423+" rather than a smaller total.
  const badgeFor = (item: NavLink, cnt: number | null) =>
    navBadge(
      cnt,
      navPartial(item, (key) => counts.unavailable.includes(key))
    );
  const PARTIAL_TITLE = 'Some counts are unavailable';

  const lastActioned = sidebarLastActioned();
  const queueOldest = sidebarQueueOldest();
  const clock = minuteClock();
  const now = $derived(clock.now);
  // Nothing until both lookups land: with one missing, the badge would time from the wrong event and
  // jump when the other arrives.
  const actionedFor = (link: NavLink, count: number | null) =>
    link.countKey && lastActioned.value && queueOldest.value
      ? queueWaitBadge(
          link.countKey,
          lastActioned.value[link.countKey]?.at,
          queueOldest.value[link.countKey],
          count,
          now
        )
      : null;

  // Threshold colour on top-level counts only; a group takes its worst queue's, so a collapsed group
  // still says when something inside it is behind.
  const severityFor = (link: NavLink) => severityClassForRank(navWorstRank(link, countFor));
  const overThreshold = (link: NavLink) =>
    (navWorstRank(link, countFor) ?? Infinity) <= URGENT_SEVERITY_RANK;

  // Collapsed unless you're working inside the section or something in it is over threshold; an
  // explicit toggle wins from then on.
  let openGroups = $state<Record<string, boolean>>({});
  const holdsCurrentPage = (item: NavLink) =>
    !!item.children?.some(
      (child) => !child.external && !!child.path && isPathActive(child.path, page.url.pathname)
    );
  const isOpen = (item: NavLink) =>
    openGroups[item.label] ?? (holdsCurrentPage(item) || overThreshold(item));

  const who = $derived(data.user?.username ?? `user #${data.user?.id}`);

  // Stored absolute URLs (an appeal's link, pasted text) still name `.com`; every builder here already
  // uses the link base. Rewritten on hover or focus, so the status bar, copy-link and middle-click agree.
  const retarget = (event: Event) => {
    const a = (event.target as Element | null)?.closest?.('a[href]');
    if (!(a instanceof HTMLAnchorElement)) return;
    const next = toLinkBase(a.href, data.civitaiUrl);
    if (next !== a.href) a.href = next;
  };
</script>

<svelte:document onpointerover={retarget} onfocusin={retarget} />

<SidebarProvider>
  {#if navigating.to}
    <div
      class="pointer-events-none fixed inset-x-0 top-0 z-100 h-0.5 overflow-hidden"
      role="status"
      aria-label="Loading"
    >
      <div class="nav-progress-bar h-full w-2/5 rounded-full bg-primary"></div>
    </div>
  {/if}
  <Sidebar>
    <SidebarHeader>
      <a
        href="/"
        aria-label="Civitai Moderator"
        class="flex items-center gap-2 px-2 py-1 [&>span>svg]:block [&>span>svg]:h-6 [&>span>svg]:w-auto"
      >
        <!-- `buildWordmarkSvg` builds this string from a literal template in @civitai/brand and
             interpolates only a colour we pass in — no user input reaches it, and the SVG is inlined
             rather than <img> so it can inherit `currentColor`. -->
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        <span>{@html wordmark}</span>
        <span
          class="rounded bg-sidebar-accent px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-accent-foreground"
        >
          mod
        </span>
      </a>
    </SidebarHeader>

    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {#each data.nav as item (item.path ?? item.label)}
                {@const Icon = iconFor(item)}
                {#if item.children}
                  {@const rollup = badgeFor(item, rollupFor(item))}
                  <Collapsible
                    open={isOpen(item)}
                    onOpenChange={(o) => (openGroups[item.label] = o)}
                  >
                    <SidebarMenuItem>
                      <CollapsibleTrigger>
                        {#snippet child({ props })}
                          <SidebarMenuButton {...props}>
                            <Icon size={18} stroke={1.5} />
                            <span>{item.label}</span>
                            {#if rollup !== null}
                              <span
                                class="ml-auto rounded-full bg-sidebar-foreground/10 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums {severityFor(
                                  item
                                ) ?? 'text-sidebar-foreground/70'}"
                                title={rollup.partial ? PARTIAL_TITLE : undefined}
                              >
                                {rollup.text}
                              </span>
                            {/if}
                            <IconChevronRight
                              size={15}
                              class="{rollup !== null
                                ? 'ml-1'
                                : 'ml-auto'} shrink-0 text-sidebar-foreground/50 transition-transform {isOpen(
                                item
                              )
                                ? 'rotate-90'
                                : ''}"
                            />
                          </SidebarMenuButton>
                        {/snippet}
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <!-- mr-0 pr-0: the sub-list's default right inset would leave its items narrower than the
                             top-level ones; only the left indent and rule stay as the hierarchy cue. -->
                        <SidebarMenuSub class="mr-0 pr-0">
                          {#each item.children as childLink (childLink.path ?? childLink.label)}
                            {@const count = navCount(childLink, countFor)}
                            {@const cnt = badgeFor(childLink, count)}
                            {@const actioned = actionedFor(childLink, count)}
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton
                                isActive={isNavLinkActive(childLink, item.children, page.url)}
                              >
                                {#snippet child({ props })}
                                  <a
                                    href={childLink.external
                                      ? `${data.civitaiUrl}${childLink.path}`
                                      : navHref(childLink)}
                                    target={childLink.external ? '_blank' : undefined}
                                    rel={childLink.external ? 'noreferrer' : undefined}
                                    data-sveltekit-preload-data={childLink.noPreload ? 'off' : undefined}
                                    {...props}
                                  >
                                    <span>{childLink.label}{childLink.external ? ' ↗' : ''}</span>
                                    <!-- Beside the label, not the count: the counts stay one right-aligned column. -->
                                    {#if actioned}
                                      {@const badgeClass = `shrink-0 rounded bg-sidebar-foreground/10 px-1 text-[10px] font-semibold tabular-nums ${actioned.class}`}
                                      <ShortAge
                                        at={actioned.at}
                                        {now}
                                        title={actioned.title}
                                        class={badgeClass}
                                      />
                                    {/if}
                                    {#if cnt !== null}
                                      <span
                                        class="ml-auto text-xs tabular-nums text-sidebar-foreground/50"
                                        title={cnt.partial ? PARTIAL_TITLE : undefined}
                                      >
                                        {cnt.text}
                                      </span>
                                    {/if}
                                  </a>
                                {/snippet}
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          {/each}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                {:else}
                  {@const cnt = badgeFor(item, navCount(item, countFor))}
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={!!item.path && isPathActive(item.path, page.url.pathname)}
                    >
                      {#snippet child({ props })}
                        <a href={item.path} {...props}>
                          <Icon size={18} stroke={1.5} />
                          <span>{item.label}</span>
                          {#if cnt !== null}
                            <span
                              class="ml-auto rounded-full bg-sidebar-foreground/10 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums {severityFor(
                                item
                              ) ?? 'text-sidebar-foreground/70'}"
                              title={cnt.partial ? PARTIAL_TITLE : undefined}
                            >
                              {cnt.text}
                            </span>
                          {/if}
                        </a>
                      {/snippet}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                {/if}
            {/each}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
      <div class="flex items-center gap-2 px-1 py-1">
        <Avatar class="size-8">
          {#if data.user?.image}
            <!-- `image` is a bare Cloudflare key, not a URL. Handed straight to <img src> the browser
                 resolves it against the current route, so every page requested `/<route-parent>/<guid>`
                 and 404'd. getEdgeUrl builds the CDN URL — same as creator-studio's AccountSwitcher. -->
            <AvatarImage src={getEdgeUrl(data.user.image, { width: 96 })} alt={who} />
          {/if}
          <AvatarFallback>{who.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span class="min-w-0 flex-1 truncate text-sm" title={who}>{who}</span>
        {#if data.logoutUrl}
          <a
            href={data.logoutUrl}
            data-sveltekit-reload
            aria-label="Sign out"
            title="Sign out"
            class="rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <IconLogout size={18} stroke={1.5} />
          </a>
        {/if}
      </div>
      <p class="m-0 px-2 text-[11px] tabular-nums text-dark-2">v{__APP_VERSION__}</p>
    </SidebarFooter>
  </Sidebar>

  <!-- min-w-0: a flex item's automatic minimum is its content's width, so one wide table would widen
       the whole content column past the viewport instead of scrolling inside its own container. -->
  <SidebarInset class="min-w-0">
    <!-- headerInline: the page's own header starts at the top and leaves room for the trigger, which
         floats over it instead of reserving a row. -->
    <header
      class={page.data.headerInline
        ? 'absolute top-0 left-0 z-10 flex h-12 items-center px-4'
        : 'flex h-12 shrink-0 items-center gap-2 px-4'}
    >
      <SidebarTrigger />
    </header>
    <!-- fullBleed: edge-to-edge, self-managed height (scanner focused review). wide: full content width
         (no cap) for image-heavy grids. default: readable text width. -->
    <div
      class={page.data.fullBleed
        ? 'min-h-0 flex-1'
        : page.data.wide
          ? 'w-full px-6 pb-10'
          : 'mx-auto w-full max-w-6xl px-6 pb-10'}
    >
      {@render children()}
    </div>
  </SidebarInset>
</SidebarProvider>

<!-- Success confirmations: a write that changes nothing on screen (a publish toggle, a saved banner)
     otherwise gives the operator no signal that it landed. -->
<Toaster position="bottom-right" />

<QuickSwitcher nav={data.nav} civitaiUrl={data.civitaiUrl} />

{#if data.canSeeUserCard}<UserCardPopover />{/if}

<style>
  .nav-progress-bar {
    animation: nav-progress 1.1s ease-in-out infinite;
  }
  @keyframes nav-progress {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(350%);
    }
  }
</style>
