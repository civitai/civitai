<script lang="ts">
  import RunDetail from '../../routes/RunDetail.svelte';
  import { backend } from '$lib/host';
  import type { TrainingDetail } from '$lib/data/trainingRows';

  let { workflowId }: { workflowId: string } = $props();

  // First load per run: a new workflowId derives a new promise and the template re-awaits it.
  const initial = $derived(backend().getRunDetail(workflowId));

  // RunDetail's own poll/signal timers call onRefresh; overlaying the refetched detail (instead of
  // re-deriving `initial`) keeps the component mounted, so a 5s poll can't reset the selected
  // checkpoint / open viewer the way a remount would.
  let refreshed = $state<TrainingDetail | null>(null);
  $effect(() => {
    void workflowId;
    refreshed = null;
  });
  async function onRefresh() {
    const id = workflowId;
    try {
      const next = await backend().getRunDetail(id);
      // A run→run navigation may have happened while this was in flight — never land a stale
      // response on the new subject.
      if (id === workflowId) refreshed = next;
    } catch {
      // Keep showing the last detail; the next poll tick retries.
    }
  }
</script>

{#await initial}
  <p class="p-6 font-mono text-sm text-dark-2">Loading training…</p>
{:then loaded}
  <RunDetail detail={refreshed ?? loaded} {onRefresh} />
{:catch err}
  <p class="p-6 font-mono text-sm text-red-400">
    Could not load this training: {err instanceof Error ? err.message : String(err)}
  </p>
{/await}
