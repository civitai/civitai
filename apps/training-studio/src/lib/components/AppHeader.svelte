<script lang="ts">
  import { browser } from '$lib/host';
  import { IconBoltFilled, IconCheck, IconChevronDown } from '@tabler/icons-svelte';
  import { getEdgeUrl } from '$lib/edge-url';
  import { buzzMode, type BuzzMode } from '$lib/buzz-mode.svelte';
  import { buzzBalance } from '$lib/buzz-balance.svelte';
  import { dismiss } from '$lib/actions/dismiss';

  let {
    username,
    image,
    logoutUrl,
    buzz: initialBuzz,
  }: {
    username?: string;
    image?: string;
    logoutUrl?: string | null;
    buzz?: { yellow: number; green: number; blue: number } | null;
  } = $props();

  const avatarUrl = $derived(getEdgeUrl(image));
  // The live store (updated by `buzz:update` signals) wins once seeded in the browser; the load-provided
  // prop is the SSR / signals-off fallback.
  const buzz = $derived((browser && buzzBalance.value) || initialBuzz);
  // The chosen primary account's balance (yellow or green); blue (generation) is always available too.
  const primaryBalance = $derived(buzz ? (buzzMode.value === 'green' ? buzz.green : buzz.yellow) : 0);

  let menuOpen = $state(false);
  let buzzMenuOpen = $state(false);

  function pick(next: BuzzMode) {
    buzzMode.set(next);
    buzzMenuOpen = false;
  }
</script>

<header class="mb-6 flex items-center justify-between gap-3">
  <a href="/" class="flex items-center gap-2.5">
    <span
      class="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-sky-700 to-sky-400 text-sm font-bold text-white"
    >
      C
    </span>
    <div class="font-semibold leading-tight text-white">
      Training Studio
      <span class="block font-mono text-xs uppercase tracking-widest text-dark-2">Beta</span>
    </div>
  </a>

  <div class="flex items-center gap-4">
    <a href="/" class="font-mono text-sm text-dark-2 transition-colors hover:text-white">
      My trainings
    </a>
    {#if buzz}
      <details
        class="relative"
        bind:open={buzzMenuOpen}
        use:dismiss={{ enabled: buzzMenuOpen, onDismiss: () => (buzzMenuOpen = false) }}
      >
        <summary
          class="flex cursor-pointer list-none items-center gap-1.5 rounded-full bg-buzz/15 px-2.5 py-1 font-mono text-sm font-semibold text-buzz transition-colors hover:bg-buzz/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-buzz [&::-webkit-details-marker]:hidden"
        >
          <IconBoltFilled size={15} stroke={2} />
          {primaryBalance.toLocaleString()}
          <span class="text-xs font-normal capitalize opacity-70">{buzzMode.value}</span>
          <span
            class="ml-1 inline-flex items-center border-l border-dark-4 pl-1.5 text-xs font-normal text-blue-400"
          >
            <IconBoltFilled size={11} stroke={2} />{buzz.blue.toLocaleString()}
          </span>
          <IconChevronDown size={13} stroke={2} class="opacity-70" />
        </summary>
        <div
          class="absolute right-0 z-20 mt-2 min-w-[240px] rounded-md border border-dark-4 bg-dark-6 p-1 shadow-lg"
        >
          <div class="px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-dark-2">
            Buzz to spend
          </div>
          {#each [{ mode: 'yellow', label: 'Yellow', balance: buzz.yellow }, { mode: 'green', label: 'Green', balance: buzz.green }] as const as opt (opt.mode)}
            <button
              type="button"
              onclick={() => pick(opt.mode)}
              class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-dark-5"
            >
              <IconBoltFilled
                size={14}
                stroke={2}
                class={opt.mode === 'green' ? 'text-emerald-400' : 'text-buzz'}
              />
              <span class="text-dark-0">{opt.label}</span>
              <span class="ml-auto font-mono text-xs text-dark-2">{opt.balance.toLocaleString()}</span>
              {#if buzzMode.value === opt.mode}
                <IconCheck size={14} stroke={2.5} class="text-primary" />
              {/if}
            </button>
          {/each}
          <p class="px-3 pb-1.5 pt-1 text-xs leading-snug text-dark-2">
            <span class="text-emerald-400">Green</span> (membership) Buzz can't be used to train NSFW
            content. <span class="text-blue-400">Blue</span> (free) always spends first; your pick
            covers the rest.
          </p>
        </div>
      </details>
    {/if}
    {#if username}
      <details
        class="relative"
        bind:open={menuOpen}
        use:dismiss={{ enabled: menuOpen, onDismiss: () => (menuOpen = false) }}
      >
        <summary
          class="flex cursor-pointer list-none items-center gap-2 rounded-full py-0.5 pl-0.5 pr-2 transition-colors hover:bg-dark-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden"
        >
          {#if avatarUrl}
            <img src={avatarUrl} alt="" class="h-8 w-8 rounded-full object-cover" />
          {:else}
            <span
              class="grid h-8 w-8 place-items-center rounded-full bg-dark-5 text-xs font-semibold text-dark-0"
            >
              {username.slice(0, 1).toUpperCase()}
            </span>
          {/if}
          <span class="hidden text-sm text-dark-0 sm:inline">{username}</span>
          <IconChevronDown size={14} stroke={2} class="text-dark-2" />
        </summary>
        <div
          class="absolute right-0 z-20 mt-2 min-w-[180px] rounded-md border border-dark-4 bg-dark-6 p-1 shadow-lg"
        >
          <div class="px-3 py-2 text-xs text-dark-2">
            Signed in as <span class="text-dark-0">{username}</span>
          </div>
          {#if logoutUrl}
            <a
              href={logoutUrl}
              class="block rounded px-3 py-2 text-sm text-dark-2 transition-colors hover:bg-dark-5 hover:text-white"
            >
              Sign out
            </a>
          {/if}
        </div>
      </details>
    {/if}
  </div>
</header>
