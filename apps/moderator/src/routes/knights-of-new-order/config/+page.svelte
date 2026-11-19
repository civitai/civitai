<script lang="ts">
  import ConfigEditor from './ConfigEditor.svelte';
  import RecentChanges from './RecentChanges.svelte';
  import StatusStrip from './StatusStrip.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-4">
  <header class="page-header">
    <h1>Knights of New Order config</h1>
    <p>Tune the Knights game. Changes reach the site within about 30 seconds.</p>
  </header>

  <StatusStrip context={data.context} />

  {#key JSON.stringify(data.settings)}
    <ConfigEditor settings={data.settings} />
  {/key}

  <RecentChanges lastChange={data.lastChange} />
</div>
