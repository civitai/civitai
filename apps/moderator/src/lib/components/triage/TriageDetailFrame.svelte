<script lang="ts">
  import type { Snippet } from 'svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let {
    verdict,
    error,
    children,
    actions,
  }: {
    /** The outcome already chosen for this item, shown in place of the actions. */
    verdict: string | undefined;
    error: string | undefined;
    children: Snippet;
    /** Rendered only while no outcome is chosen; with none, there is no action bar at all. */
    actions?: Snippet;
  } = $props();
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex-1 space-y-5 overflow-y-auto p-5">
    {@render children()}
  </div>

  {#if actions}
    {#if error}
      <ErrorAlert class="mx-5 mb-3" message={error} />
    {/if}
    <div
      data-triage-actions
      class="sticky bottom-0 flex shrink-0 flex-wrap items-center gap-3 border-t border-dark-4 bg-dark-6 px-5 py-3"
    >
      <div role="status" class="text-base font-medium text-white empty:sr-only">{#if verdict}{verdict}{/if}</div>
      {#if !verdict}
        {@render actions()}
      {/if}
    </div>
  {/if}
</div>
