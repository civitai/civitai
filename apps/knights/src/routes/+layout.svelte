<script lang="ts">
  import '../global.css';
  import '../motion.css';
  import { afterNavigate, invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import AppHeader from '$lib/AppHeader.svelte';
  import WhatsNewDialog from '$lib/WhatsNewDialog.svelte';
  import type { PlayerStatus } from '$lib/server/player-status';
  import type { WhatsNewItem } from '$lib/whats-new';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  // A page that loads the player's status (play keeps it live) hands it to the header through page.data; every other page
  // gets the layout's copy, so the header is the same on each of them.
  type Streak = { streak: number; shields: number; maxShields: number };
  let status = $derived(
    (page.data.status as PlayerStatus | null | undefined) ?? data.headerStats?.status ?? undefined
  );
  let streak = $derived((page.data.daily as Streak | null | undefined) ?? data.headerStats?.daily ?? undefined);
  // /play keeps its own live status for the header while it is open, so the layout's copy is as old as the visit. Leaving
  // refreshes it for the pages that carry no status of their own.
  afterNavigate(({ from }) => {
    if (from?.route.id === '/play') void invalidate('knights:header');
  });
  // /play fills the viewport exactly: the image stage takes whatever the header and the answer row leave.
  // The welcome screen is signed-out and brings its own chrome.
  let bare = $derived(page.route.id === '/');
  // /home and /play each load "What's new" and answer its `dismissWhatsNew` action; whichever opens first shows it.
  let whatsNew = $derived(page.data.whatsNew as { items: WhatsNewItem[] } | null | undefined);
  let dismissingWhatsNew = $state(false);
  const submitWhatsNew: SubmitFunction = () => {
    dismissingWhatsNew = true;
    return async ({ update }) => {
      try {
        await update();
      } finally {
        dismissingWhatsNew = false;
      }
    };
  };
  let fit = $derived(page.route.id === '/play');
</script>

{#if bare}
  {@render children()}
{:else}
  <div class="app" class:fit>
    <AppHeader
      player={data.player}
      userId={data.userId}
      civitaiUrl={data.civitaiUrl}
      shopOpen={data.shopOpen}
      isPlayer={data.isPlayer}
      feedbackOpen={data.feedbackOpen}
      {status}
      {streak}
      recapUnseen={data.recapUnseen}
      goldPerBuzz={data.goldPerBuzz}
      ladder={data.ladder}
      badges={data.badges}
    />
    <main>
      {@render children()}
    </main>
  </div>
  {#if whatsNew}
    <WhatsNewDialog
      items={whatsNew.items}
      message={page.form?.whatsNewFailed ? page.form.message : null}
      submitting={dismissingWhatsNew}
      submit={submitWhatsNew}
    />
  {/if}
{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh;
  }
  main {
    flex: 1 1 auto;
    width: 100%;
    max-width: 48rem;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 3rem;
  }
  .fit {
    height: 100vh;
    height: 100dvh;
  }
  .fit main {
    display: flex;
    flex-direction: column;
    min-height: 0;
    max-width: none;
    padding: 0;
    overflow-y: auto;
  }
  /* Must match PrimaryNav's tab-bar breakpoint and height. */
  @media (max-width: 75rem) {
    .app {
      padding-bottom: calc(57px + env(safe-area-inset-bottom));
    }
  }
  @media (max-width: 40rem) {
    main {
      padding: 1rem 1rem 1.5rem;
    }
  }
</style>
