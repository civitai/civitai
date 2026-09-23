<script lang="ts">
  import { page, navigating } from '$app/state';
  import { buildWordmarkSvg } from '@civitai/brand';
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
    SidebarFooter,
    SidebarInset,
    SidebarTrigger,
  } from '@civitai/ui/components/ui/sidebar/index.js';
  import { Toaster } from '@civitai/ui/components/ui/sonner/index.js';
  import { IconArrowLeft } from '@tabler/icons-svelte';
  import AccountSwitcher from '$lib/components/AccountSwitcher.svelte';
  import { ADMIN_NAV, isAdminNavActive } from '$lib/admin-nav';
  import { refetching } from '$lib/state/refetching.svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  const wordmark = buildWordmarkSvg({ base: '#e8eaed' });
  const who = $derived(data.user.username ?? `user #${data.user.id}`);
  // Any load in flight — a real page nav or an in-place query change (e.g. a range selector, which re-runs
  // the server load without leaving the route). Drives the top progress bar.
  const isNavigating = $derived(!!navigating.to || refetching.active);
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
        href="/admin"
        aria-label="Civitai Creator Studio admin"
        class="flex items-center gap-2 px-2 py-1 [&>span>svg]:block [&>span>svg]:h-6 [&>span>svg]:w-auto"
      >
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- buildWordmarkSvg output; no user input -->
        <span>{@html wordmark}</span>
        <span
          class="rounded bg-red-9 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-white"
        >
          admin
        </span>
      </a>
    </SidebarHeader>

    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {#each ADMIN_NAV as item (item.href)}
              {@const Icon = item.icon}
              {@const active = isAdminNavActive(item.href, page.url.pathname)}
              <SidebarMenuItem>
                <SidebarMenuButton isActive={active}>
                  {#snippet child({ props })}
                    <!-- The button's `data-active:` styles key on attribute PRESENCE, and the component
                         always emits data-active (as "true"/"false"), so every item would match. Force it
                         absent on inactive items. Resting text color is set too, since the global `a` rule
                         would otherwise paint every link blue. -->
                    <a
                      href={item.href}
                      {...props}
                      data-active={active ? true : undefined}
                      class={`${props.class ?? ''} text-sidebar-foreground data-active:text-sidebar-accent-foreground`}
                    >
                      <Icon size={18} stroke={1.5} />
                      <span>{item.label}</span>
                    </a>
                  {/snippet}
                </SidebarMenuButton>
              </SidebarMenuItem>
            {/each}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
      <a
        href="/dashboard"
        class="flex items-center gap-2 px-2 py-1.5 text-xs text-dark-1 hover:text-white"
      >
        <IconArrowLeft size={14} stroke={1.5} />
        Back to Creator Studio
      </a>
      <p class="px-2 pb-1 text-xs tabular-nums text-dark-2">v{__APP_VERSION__}</p>
      <div class="px-1 py-1">
        <AccountSwitcher name={who} image={data.user.image} logoutUrl={data.logoutUrl} />
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
