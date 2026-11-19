<script lang="ts">
  import ConfigEditor from './ConfigEditor.svelte';
  import RecentChanges from './RecentChanges.svelte';
  import RuleGuideEditor from './RuleGuideEditor.svelte';
  import StatusStrip from './StatusStrip.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Each card re-seeds only when its own part of the config changes, so saving one keeps unsaved typing in the other.
  const otherSettings = $derived.by(() => {
    const { ruleGuide: _rules, ...config } = data.settings.config;
    return JSON.stringify({ ...data.settings, config });
  });
</script>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-4">
  <header class="page-header">
    <h1>Knights of New Order config</h1>
    <p>Tune the Knights game. Changes reach the site within about 30 seconds.</p>
  </header>

  <StatusStrip context={data.context} />

  {#key otherSettings}
    <ConfigEditor settings={data.settings} />
  {/key}

  {#key JSON.stringify(data.settings.config.ruleGuide ?? null)}
    <RuleGuideEditor guide={data.settings.config.ruleGuide} />
  {/key}

  <RecentChanges lastChange={data.lastChange} />
</div>
