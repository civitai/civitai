<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import ReportQueueShell from '$lib/components/report-queue/ReportQueueShell.svelte';
  import ModelQueue from './ModelQueue.svelte';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<ReportQueueShell detailLabel="Report details" detail={children}>
  {#snippet queue()}
    <ModelQueue {data} />
  {/snippet}
</ReportQueueShell>
