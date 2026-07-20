<script lang="ts">
  import '../global.css';
  import { page, navigating } from '$app/state';
  import { invalidateAll } from '$app/navigation';
  import { buildWordmarkSvg } from '@civitai/brand';
  import { IconLogout } from '@tabler/icons-svelte';
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
  import { Avatar, AvatarImage, AvatarFallback } from '@civitai/ui/components/ui/avatar/index.js';
  import { NativeSelect, NativeSelectOption } from '@civitai/ui/components/ui/native-select/index.js';
  import { Toaster } from '@civitai/ui/components/ui/sonner/index.js';
  import { activeNavHref, isNavChildActive, navForMember } from '$lib/nav';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  const wordmark = buildWordmarkSvg({ base: '#e8eaed' });

  const nav = $derived(navForMember(data.membership.isCreatorProgramMember));
  const who = $derived(data.user.username ?? `user #${data.user.id}`);
  // Any load in flight — a real page nav or an in-place query change (e.g. the analytics range selector, which
  // re-runs the server load without leaving the route). Drives the top progress bar.
  const isNavigating = $derived(!!navigating.to);
  // Exactly one active item — longest matching href wins so a parent doesn't also light up on a child route.
  const activeHref = $derived(activeNavHref(page.url.pathname));
  // Preserve the range (from/to) when switching between a section's sub-pages.
  const qs = $derived(page.url.search);

  // Moderator-only membership simulator. The `cs-test-membership` cookie is read (mod-gated) by the server
  // resolver in $lib/server/membership; here we just set/clear it and re-run the loads.
  const membershipOptions = [
    { value: '', label: 'Real membership' },
    { value: 'creator-program', label: 'Creator Program' },
  ];
  function setTestMembership(value: string) {
    document.cookie = value
      ? `cs-test-membership=${value}; path=/; max-age=86400; samesite=lax`
      : 'cs-test-membership=; path=/; max-age=0; samesite=lax';
    invalidateAll();
  }
</script>

{#if isNavigating}
  <div class="nav-progress" role="status" aria-label="Loading">
    <div class="nav-progress-bar bg-blue-8"></div>
  </div>
{/if}

<SidebarProvider>
  <Sidebar>
    <SidebarHeader>
      <a
        href="/"
        aria-label="Civitai Creator Studio"
        class="flex items-center gap-2 px-2 py-1 [&>span>svg]:block [&>span>svg]:h-6 [&>span>svg]:w-auto"
      >
        <span>{@html wordmark}</span>
        <span
          class="rounded bg-sidebar-accent px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-accent-foreground"
        >
          studio
        </span>
      </a>
    </SidebarHeader>

    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {#each nav as item (item.href)}
              {@const Icon = item.icon}
              <SidebarMenuItem>
                <SidebarMenuButton isActive={item.href === activeHref}>
                  {#snippet child({ props })}
                    <!-- The button's `data-active:` styles key on attribute PRESENCE ([data-active]), and the
                         component always emits data-active (as "true"/"false"), so every item matched. Force it
                         absent on inactive items. Resting text color is set too, since the global `a` rule
                         would otherwise paint every link blue. -->
                    <a
                      href={item.href}
                      {...props}
                      data-active={item.href === activeHref ? true : undefined}
                      class={`${props.class ?? ''} text-sidebar-foreground data-active:text-sidebar-accent-foreground`}
                    >
                      <Icon size={18} stroke={1.5} />
                      <span>{item.label}</span>
                      {#if item.memberOnly && !data.membership.isCreatorProgramMember}
                        <span
                          class="ml-auto rounded bg-dark-6 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-dark-2"
                          title="Requires a membership"
                        >
                          member
                        </span>
                      {/if}
                    </a>
                  {/snippet}
                </SidebarMenuButton>
                {#if item.children && item.href === activeHref}
                  <SidebarMenuSub>
                    {#each item.children as sub (sub.href)}
                      {@const active = isNavChildActive(sub.href, page.url.pathname)}
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton isActive={active}>
                          {#snippet child({ props })}
                            <a
                              href="{sub.href}{qs}"
                              {...props}
                              data-active={active ? true : undefined}
                              class={`${props.class ?? ''} text-sidebar-foreground data-active:text-sidebar-accent-foreground`}
                            >
                              <span>{sub.label}</span>
                            </a>
                          {/snippet}
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    {/each}
                  </SidebarMenuSub>
                {/if}
              </SidebarMenuItem>
            {/each}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
      {#if data.isModerator}
        <div class="px-1 pb-1">
          <label
            for="cs-sim-membership"
            class="mb-1 block text-[10px] font-medium uppercase tracking-wider text-dark-3"
          >
            Simulate membership (test)
          </label>
          <NativeSelect
            id="cs-sim-membership"
            value={data.testMembership ?? ''}
            onchange={(e) => setTestMembership(e.currentTarget.value)}
            class="h-auto py-1 text-xs [&>option]:bg-dark-7 [&>option]:text-white"
          >
            {#each membershipOptions as opt (opt.value)}
              <NativeSelectOption value={opt.value}>{opt.label}</NativeSelectOption>
            {/each}
          </NativeSelect>
        </div>
      {/if}
      <div class="flex items-center gap-2 px-1 py-1">
        <Avatar class="size-8">
          {#if data.user.image}
            <AvatarImage src={data.user.image} alt={who} />
          {/if}
          <AvatarFallback>{who.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span class="min-w-0 flex-1 truncate text-sm" title={who}>{who}</span>
        {#if data.logoutUrl}
          <a
            href={data.logoutUrl}
            aria-label="Sign out"
            title="Sign out"
            class="rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <IconLogout size={18} stroke={1.5} />
          </a>
        {/if}
      </div>
    </SidebarFooter>
  </Sidebar>

  <SidebarInset>
    <header class="flex h-12 shrink-0 items-center gap-2 px-4">
      <SidebarTrigger />
    </header>
    <div class="mx-auto w-full max-w-6xl px-6 pb-10">
      {@render children()}
    </div>
  </SidebarInset>
</SidebarProvider>

<Toaster richColors position="bottom-right" />

<style>
  .nav-progress {
    position: fixed;
    inset: 0 0 auto 0;
    height: 2px;
    z-index: 100;
    overflow: hidden;
  }
  .nav-progress-bar {
    position: absolute;
    top: 0;
    height: 100%;
    width: 40%;
    animation: nav-progress-slide 1.1s ease-in-out infinite;
  }
  @keyframes nav-progress-slide {
    0% {
      left: -40%;
    }
    100% {
      left: 100%;
    }
  }
</style>
