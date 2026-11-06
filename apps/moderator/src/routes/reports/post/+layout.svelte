<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import ReportQueueShell from '$lib/components/report-queue/ReportQueueShell.svelte';
  import { ReportEntity } from '$lib/reports';
  import PostQueue from './PostQueue.svelte';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<ReportQueueShell entity={ReportEntity.Post} title="Post reports" detailLabel="Reported post" detail={children}>
  {#snippet queue()}
    <PostQueue {data} />
  {/snippet}
</ReportQueueShell>
