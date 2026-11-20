<script lang="ts">
  import InquisitorPlay from './InquisitorPlay.svelte';
  import PlayerPlay from './PlayerPlay.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<!-- Moderators play the in-game inquisitor queue; everyone else plays their rank's game. -->
{#if data.mode === 'inquisitor'}
  <InquisitorPlay {data} {form} />
{:else}
  <PlayerPlay {data} {form} />
{/if}
