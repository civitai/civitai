<script lang="ts">
  import '../global.css';
  import '../motion.css';
  import { page } from '$app/state';
  import AppHeader from '$lib/AppHeader.svelte';
  import type { PlayerStatus } from '$lib/server/player-status';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  // Pages that already load the player's status (play, gold, ranks, judgments) hand it to the header through
  // page.data, so the stats cost no query of their own; other pages get the plain header.
  let status = $derived(page.data.status as PlayerStatus | undefined);
  let streak = $derived(page.data.daily as { streak: number; shields: number; maxShields: number } | undefined);
  // /play fills the viewport exactly: the image stage takes whatever the header and the answer row leave.
  // The welcome screen is signed-out and brings its own chrome.
  let bare = $derived(page.route.id === '/welcome');
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
      conversionOpen={data.conversionOpen}
      {status}
      {streak}
    />
    <main>
      {@render children()}
    </main>
  </div>
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
  @media (max-width: 40rem) {
    main {
      padding: 1rem 1rem 1.5rem;
    }
  }
</style>
