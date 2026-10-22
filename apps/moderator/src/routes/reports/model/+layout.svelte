<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import { reportEntityLabels } from '$lib/reports';
  import ReportQueueShell from '$lib/components/report-queue/ReportQueueShell.svelte';
  import ModelQueue from './ModelQueue.svelte';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<ReportQueueShell title="{reportEntityLabels[data.type]} reports" detailLabel="Report details" detail={children}>
  {#snippet queue()}
    <ModelQueue {data} />
  {/snippet}
</ReportQueueShell>
