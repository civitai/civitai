<script lang="ts">
  import ContextPanel from './ContextPanel.svelte';
  import SourcesForm from './SourcesForm.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Knights of New Order config</h1>
  <p>
    Switch the image sources that fill the Knights queue and set how much of the incoming flow they
    take. Changes reach the site within about 30 seconds.
  </p>
</header>

<div class="grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
  {#key data.lastChange?.at}
    <SourcesForm settings={data.settings} lastChange={data.lastChange} />
  {/key}
  <ContextPanel context={data.context} />
</div>
