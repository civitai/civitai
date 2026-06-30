<script lang="ts">
  import '../global.css';
  import { page } from '$app/state';
  import { buildWordmarkSvg } from '@civitai/brand';
  import {
    IconLayoutDashboard,
    IconFlag,
    IconPhoto,
    IconUsers,
    IconShieldLock,
    IconLogout,
  } from '@tabler/icons-svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  const wordmark = buildWordmarkSvg({ base: '#e8eaed' });

  const nav = $derived([
    { href: '/', label: 'Dashboard', icon: IconLayoutDashboard },
    { href: '/reports', label: 'Reports', icon: IconFlag },
    { href: '/images', label: 'Images', icon: IconPhoto },
    { href: '/users', label: 'Users', icon: IconUsers },
    ...(data.isAdmin ? [{ href: '/admin', label: 'Permissions', icon: IconShieldLock }] : []),
  ]);

  const isActive = (href: string, path: string) =>
    href === '/' ? path === '/' : path === href || path.startsWith(href + '/');

  const who = $derived(data.user?.username ?? `user #${data.user?.id}`);
</script>

<div class="flex min-h-screen">
  <aside class="flex w-64 shrink-0 flex-col border-r border-dark-4 bg-dark-8">
    <a
      href="/"
      aria-label="Civitai Moderator"
      class="flex items-center gap-2 px-5 py-4 [&>span>svg]:block [&>span>svg]:h-6 [&>span>svg]:w-auto"
    >
      <span>{@html wordmark}</span>
      <span class="rounded bg-dark-6 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-dark-2">
        mod
      </span>
    </a>

    <nav class="flex-1 space-y-1 px-3 py-2">
      {#each nav as item (item.href)}
        {@const Icon = item.icon}
        {@const active = isActive(item.href, page.url.pathname)}
        <a
          href={item.href}
          aria-current={active ? 'page' : undefined}
          class={[
            'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
            active
              ? 'bg-blue-8/15 text-blue-4'
              : 'text-dark-1 hover:bg-white/5 hover:text-dark-0',
          ]}
        >
          <Icon size={20} stroke={1.5} />
          <span>{item.label}</span>
        </a>
      {/each}
    </nav>

    <div class="flex items-center gap-2.5 border-t border-dark-4 px-4 py-3">
      {#if data.user?.image}
        <img
          src={data.user.image}
          alt=""
          referrerpolicy="no-referrer"
          class="size-8 shrink-0 rounded-full object-cover"
        />
      {:else}
        <span class="grid size-8 shrink-0 place-items-center rounded-full bg-dark-6 text-sm font-semibold text-dark-0">
          {who.charAt(0).toUpperCase()}
        </span>
      {/if}
      <span class="min-w-0 flex-1 truncate text-sm text-dark-0" title={who}>{who}</span>
      {#if data.logoutUrl}
        <a
          href={data.logoutUrl}
          aria-label="Sign out"
          title="Sign out"
          class="shrink-0 rounded-md p-1.5 text-dark-2 transition-colors hover:bg-white/5 hover:text-dark-0"
        >
          <IconLogout size={18} stroke={1.5} />
        </a>
      {/if}
    </div>
  </aside>

  <main class="flex-1 overflow-x-hidden">
    <div class="mx-auto max-w-6xl px-8 py-8">
      {@render children()}
    </div>
  </main>
</div>
