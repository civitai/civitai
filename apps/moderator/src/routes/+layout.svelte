<script lang="ts">
  import '../global.css';
  import { page, navigating } from '$app/state';
  import { buildWordmarkSvg } from '@civitai/brand';
  import {
    IconLayoutDashboard,
    IconFlag,
    IconPhoto,
    IconArticle,
    IconUsers,
    IconShieldLock,
    IconChartBar,
    IconCircle,
    IconLogout,
  } from '@tabler/icons-svelte';
  import {
    Sidebar,
    SidebarProvider,
    SidebarHeader,
    SidebarContent,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuButton,
    SidebarFooter,
    SidebarInset,
    SidebarTrigger,
  } from '@civitai/ui/components/ui/sidebar/index.js';
  import { Avatar, AvatarImage, AvatarFallback } from '@civitai/ui/components/ui/avatar/index.js';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  const wordmark = buildWordmarkSvg({ base: '#e8eaed' });

  const icons: Record<string, typeof IconLayoutDashboard> = {
    '/': IconLayoutDashboard,
    '/reports': IconFlag,
    '/images': IconPhoto,
    '/articles': IconArticle,
    '/users': IconUsers,
    '/admin': IconShieldLock,
    '/page-visits': IconChartBar,
  };
  const iconFor = (path: string) => icons[path] ?? IconCircle;

  const roleLabel = (role: string) => {
    const name = role.slice(role.indexOf(':') + 1);
    return name.charAt(0).toUpperCase() + name.slice(1);
  };

  const isActive = (href: string, path: string) =>
    href === '/' ? path === '/' : path === href || path.startsWith(href + '/');

  const who = $derived(data.user?.username ?? `user #${data.user?.id}`);
</script>

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
        <span>{@html wordmark}</span>
        <span
          class="rounded bg-sidebar-accent px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-accent-foreground"
        >
          mod
        </span>
      </a>
    </SidebarHeader>

    <SidebarContent>
      {#each data.navGroups as group (group.role ?? 'base')}
        <SidebarGroup>
          {#if group.role}
            <SidebarGroupLabel>{roleLabel(group.role)}</SidebarGroupLabel>
          {/if}
          <SidebarGroupContent>
            <SidebarMenu>
              {#each group.links as item (item.path)}
                {@const Icon = iconFor(item.path)}
                <SidebarMenuItem>
                  <SidebarMenuButton isActive={isActive(item.path, page.url.pathname)}>
                    {#snippet child({ props })}
                      <a href={item.path} {...props}>
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
      {/each}
    </SidebarContent>

    <SidebarFooter>
      <div class="flex items-center gap-2 px-1 py-1">
        <Avatar class="size-8">
          {#if data.user?.image}
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
    <div class={page.data.fullBleed ? 'min-h-0 flex-1' : 'mx-auto w-full max-w-6xl px-6 pb-10'}>
      {@render children()}
    </div>
  </SidebarInset>
</SidebarProvider>

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
