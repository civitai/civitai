<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import type { LayoutData } from './$types';
  import ReportQueueShell from '$lib/components/report-queue/ReportQueueShell.svelte';
  import { ReportEntity } from '$lib/reports';
  import QueuePanel from './QueuePanel.svelte';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  // The open account is the child page's. Read through `page.data` because a layout's own `data` is
  // only its load's.
  const suspectId = $derived(
    (page.data as { account?: { suspectId: number } | null }).account?.suspectId ?? null
  );
</script>

<ReportQueueShell entity={ReportEntity.User} title="User reports" detailLabel="Reported account" detail={children}>
  {#snippet queue()}
    <QueuePanel {data} {suspectId} />
  {/snippet}
</ReportQueueShell>
