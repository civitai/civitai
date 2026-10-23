<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import ReportQueueShell from '$lib/components/report-queue/ReportQueueShell.svelte';
  import EntityQueue from './EntityQueue.svelte';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<ReportQueueShell title={data.labels.title} detailLabel="Reported {data.labels.noun}" detail={children}>
  {#snippet queue()}
    <EntityQueue {data} />
  {/snippet}
</ReportQueueShell>
