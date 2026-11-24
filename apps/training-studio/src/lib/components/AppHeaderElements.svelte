<script lang="ts">
  import '$lib/civitai-elements';
  import type { CivitaiCheckbox } from '@civitai/components/civitai-checkbox';
  import type { CivitaiSegmentedControl } from '@civitai/components/civitai-segmented-control';
  import { browser } from '$lib/host';
  import { IconBoltFilled, IconChevronDown } from '@tabler/icons-svelte';
  import { getEdgeUrl } from '$lib/edge-url';
  import { buzzMode } from '$lib/buzz-mode.svelte';
  import { buzzBalance } from '$lib/buzz-balance.svelte';

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
  const primaryBalance = $derived(buzz ? (buzzMode.value === 'green' ? buzz.green : buzz.yellow) : 0);

  function pickMode(event: Event) {
    const value = (event.currentTarget as CivitaiSegmentedControl).value;
    if (value === 'yellow' || value === 'green') buzzMode.set(value);
  }

  function onAccountSelect(event: CustomEvent<{ value: string }>) {
    // A full load, not client navigation: /logout is a server route that clears the session.
    if (event.detail.value === 'logout' && logoutUrl) window.location.assign(logoutUrl);
  }
</script>

<header class="mb-6 flex flex-wrap items-center justify-between gap-3">
  <a href="/" class="flex shrink-0 items-center gap-2.5">
    <span
      class="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-sky-700 to-sky-400 text-sm font-bold text-white"
    >
      C
    </span>
    <div class="whitespace-nowrap font-semibold leading-tight text-white">
      Training Studio
    </div>
  </a>

  <div class="ml-auto flex items-center gap-2 sm:gap-3">
    <!-- Below sm the logo is the way home; the link would wrap the header. -->
    <civitai-button href="/" variant="subtle" class="hidden sm:inline-block">
      My trainings
    </civitai-button>
    {#if buzz}
      <studio-popover>
        <button
          slot="trigger"
          type="button"
          class="flex items-center gap-1.5 rounded-full bg-buzz/15 px-2.5 py-1 text-sm font-semibold text-buzz transition-colors hover:bg-buzz/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-buzz"
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
        </button>
        <div class="flex w-64 flex-col gap-3 text-sm">
          <!-- Host-dictated mode: the paid account is fixed, so only the Blue-first choice is offered. -->
          {#if !buzzMode.locked}
            <civitai-segmented-control
              label="Buzz to spend"
              size="sm"
              data={[
                { value: 'yellow', label: `Yellow ${buzz.yellow.toLocaleString()}` },
                { value: 'green', label: `Green ${buzz.green.toLocaleString()}` },
              ]}
              value={buzzMode.value}
              onchange={pickMode}
            ></civitai-segmented-control>
          {/if}
          <civitai-checkbox
            size="sm"
            label="Spend Blue first"
            description="{buzz.blue.toLocaleString()} Blue available"
            checked={buzzMode.blueFirst}
            onchange={(e: Event) => buzzMode.setBlueFirst((e.currentTarget as CivitaiCheckbox).checked)}
          ></civitai-checkbox>
          <p class="m-0 text-xs leading-snug text-dark-2">
            <span class="text-emerald-400">Green</span> (membership) Buzz can't be used to train NSFW
            content.
            {#if buzzMode.blueFirst}
              <span class="text-blue-400">Blue</span> (free) spends first; your
              <span class="capitalize">{buzzMode.value}</span> covers the rest.
            {:else}
              Only your <span class="capitalize">{buzzMode.value}</span> Buzz is spent.
            {/if}
          </p>
        </div>
      </studio-popover>
    {/if}
    {#if username}
      <civitai-menu placement="bottom-end" label="Account" onselect={onAccountSelect}>
        <button
          slot="trigger"
          type="button"
          class="flex items-center gap-2 rounded-full py-0.5 pl-0.5 pr-2 transition-colors hover:bg-dark-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <civitai-avatar src={avatarUrl ?? ''} name={username} size="sm"></civitai-avatar>
          <span class="hidden text-sm text-dark-0 sm:inline">{username}</span>
          <IconChevronDown size={14} stroke={2} class="text-dark-2" />
        </button>
        <civitai-menu-label>Signed in as {username}</civitai-menu-label>
        {#if logoutUrl}
          <civitai-menu-item value="logout">Sign out</civitai-menu-item>
        {/if}
      </civitai-menu>
    {/if}
  </div>
</header>
