<script lang="ts">
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';
  import { Avatar, AvatarImage, AvatarFallback } from '@civitai/ui/components/ui/avatar/index.js';
  import { IconChevronDown, IconCheck, IconLogout } from '@tabler/icons-svelte';

  type DeviceAccount = {
    userId: number;
    username?: string;
    image?: string;
    lastSwitchedAt: number;
    active: boolean;
  };

  let { name, image, logoutUrl }: { name: string; image: string | null; logoutUrl: string | null } =
    $props();

  let open = $state(false);
  let accounts = $state<DeviceAccount[]>([]);
  let loading = $state(false);
  let loaded = $state(false);
  let switching = $state<number | null>(null);
  const initial = (s: string | undefined) => (s ?? '?').charAt(0).toUpperCase();

  async function loadAccounts() {
    loading = true;
    try {
      const res = await fetch('/api/auth/accounts');
      accounts = res.ok ? ((await res.json()).accounts ?? []) : [];
    } catch {
      accounts = [];
    }
    loading = false;
    loaded = true;
  }
  // Fetch the device's accounts the first time the menu opens (avoids a request on every page load).
  $effect(() => {
    if (open && !loaded) loadAccounts();
  });

  // Others (non-active) the creator can switch to — the current account is shown as the trigger.
  const others = $derived(accounts.filter((a) => !a.active));

  async function switchTo(userId: number) {
    switching = userId;
    try {
      const res = await fetch('/api/auth/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      // On success the hub's Set-Cookie has swapped the session — full reload so every load re-resolves as the
      // new user (and clears this component's stale roster).
      if (res.ok) return location.reload();
    } catch {
      /* fall through to reset */
    }
    switching = null;
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-sidebar-accent"
  >
    <Avatar class="size-8">
      {#if image}<AvatarImage src={image} alt={name} />{/if}
      <AvatarFallback>{initial(name)}</AvatarFallback>
    </Avatar>
    <span class="min-w-0 flex-1 truncate text-sm" title={name}>{name}</span>
    <IconChevronDown size={14} class="shrink-0 text-dark-3" />
  </Popover.Trigger>
  <Popover.Content align="start" side="top" class="w-56 border-dark-4 bg-dark-7 p-1">
    <p class="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-dark-3">Accounts on this device</p>
    {#if loading}
      <p class="px-2 py-2 text-xs text-dark-3">Loading…</p>
    {:else if others.length === 0}
      <p class="px-2 py-2 text-xs text-dark-3">
        No other accounts on this device. Sign in with another account to switch between them here.
      </p>
    {:else}
      {#each others as acct (acct.userId)}
        <button
          type="button"
          disabled={switching !== null}
          onclick={() => switchTo(acct.userId)}
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-white hover:bg-dark-6 disabled:opacity-60"
        >
          <Avatar class="size-6">
            {#if acct.image}<AvatarImage src={acct.image} alt={acct.username ?? ''} />{/if}
            <AvatarFallback>{initial(acct.username)}</AvatarFallback>
          </Avatar>
          <span class="min-w-0 flex-1 truncate text-left">{acct.username ?? `User ${acct.userId}`}</span>
          {#if switching === acct.userId}<span class="text-xs text-dark-3">…</span>{/if}
        </button>
      {/each}
    {/if}
    <div class="my-1 border-t border-dark-4"></div>
    <div class="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-dark-1">
      <IconCheck size={14} class="shrink-0 text-green-5" />
      <span class="min-w-0 flex-1 truncate" title={name}>{name}</span>
      <span class="text-[10px] uppercase tracking-wide text-dark-3">current</span>
    </div>
    {#if logoutUrl}
      <a
        href={logoutUrl}
        class="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-dark-2 hover:bg-dark-6 hover:text-white"
      >
        <IconLogout size={14} class="shrink-0" />
        Sign out
      </a>
    {/if}
  </Popover.Content>
</Popover.Root>
