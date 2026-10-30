<script lang="ts">
  import { IconAlertTriangle, IconEye } from '@tabler/icons-svelte';
  import Notice from '$lib/components/Notice.svelte';
  import { ANNOUNCEMENT_METRICS_SINCE_LABEL } from '$lib/impressions';

  let { unavailable = false }: { unavailable?: boolean } = $props();
</script>

<div class="flex flex-col gap-2">
  {#if unavailable}
    <Notice icon={IconAlertTriangle}>
      <strong class="font-medium text-white">Your numbers could not be loaded.</strong> Everything else
      on this page still works. Reload in a minute — this is not a report that nobody saw your announcements.
    </Notice>
  {:else}
    <Notice icon={IconEye}>
      <strong class="font-medium text-white">Seen counts people, not opens.</strong> An announcement
      is counted once per person per visit, once it has been at least half on screen for a full
      second. Counting started on {ANNOUNCEMENT_METRICS_SINCE_LABEL}, so anything you posted before
      that has nothing recorded.
    </Notice>
  {/if}
</div>
