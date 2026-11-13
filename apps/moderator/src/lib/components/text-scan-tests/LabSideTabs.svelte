<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';

  let { tryPanel, testSets }: { tryPanel: Snippet; testSets: Snippet<[boolean]> } = $props();

  let tab = $state<'try' | 'test-sets'>('try');
</script>

<section class="min-w-0 space-y-3">
  <Tabs value={tab} onValueChange={(v) => v && (tab = v as typeof tab)}>
    <TabsList>
      <TabsTrigger value="try">Try</TabsTrigger>
      <TabsTrigger value="test-sets">Test sets</TabsTrigger>
    </TabsList>
  </Tabs>
  <!-- Both stay mounted so a Try result survives a look at the Test sets tab. -->
  <div class={tab === 'try' ? '' : 'hidden'}>{@render tryPanel()}</div>
  <div class={tab === 'test-sets' ? '' : 'hidden'}>{@render testSets(tab === 'test-sets')}</div>
</section>
