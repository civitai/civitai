<script lang="ts">
  import '../global.css';
  import { page } from '$app/state';
  import { invalidateAll } from '$app/navigation';
  import { buildWordmarkSvg } from '@civitai/brand';
  import {
    IconLayoutDashboard,
    IconBox,
    IconCoin,
    IconChartBar,
    IconLicense,
    IconSettings,
    IconSparkles,
    IconCircle,
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
    SidebarFooter,
    SidebarInset,
    SidebarTrigger,
  } from '@civitai/ui/components/ui/sidebar/index.js';
  import { Avatar, AvatarImage, AvatarFallback } from '@civitai/ui/components/ui/avatar/index.js';
  import { activeNavHref } from '$lib/nav';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  const wordmark = buildWordmarkSvg({ base: '#e8eaed' });

  const icons: Record<string, typeof IconLayoutDashboard> = {
    dashboard: IconLayoutDashboard,
    box: IconBox,
    coin: IconCoin,
    chart: IconChartBar,
    license: IconLicense,
    settings: IconSettings,
    sparkles: IconSparkles,
  };
  const iconFor = (name: string) => icons[name] ?? IconCircle;

  const who = $derived(data.user.username ?? `user #${data.user.id}`);
  // Exactly one active item — longest matching href wins so a parent (/earnings) doesn't also light up on a
  // child route (/earnings/analytics).
  const activeHref = $derived(activeNavHref(page.url.pathname));

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
            {#each data.nav as item (item.href)}
              {@const Icon = iconFor(item.icon)}
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
                      {#if item.memberOnly && !data.membership.isMember}
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
          <select
            id="cs-sim-membership"
            value={data.testMembership ?? ''}
            onchange={(e) => setTestMembership(e.currentTarget.value)}
            class="w-full rounded border border-dark-4 bg-dark-7 px-2 py-1 text-xs text-white"
          >
            {#each membershipOptions as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
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
