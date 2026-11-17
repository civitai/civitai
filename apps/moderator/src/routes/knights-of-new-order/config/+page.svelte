<script lang="ts">
  import ContextPanel from './ContextPanel.svelte';
  import GameSettingsForm from './GameSettingsForm.svelte';
  import SourcesForm from './SourcesForm.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Knights of New Order config</h1>
  <p>
    Switch the image sources that fill the Knights queue, set how much of the incoming flow they
    take, and tune the game. Changes reach the site within about 30 seconds.
  </p>
</header>

<div class="grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
  {#key data.lastChange?.at}
    <div class="flex flex-col gap-4">
      <SourcesForm settings={data.settings} lastChange={data.lastChange} />
      <GameSettingsForm game={data.settings.config.game} />
    </div>
  {/key}
  <ContextPanel context={data.context} />
</div>
