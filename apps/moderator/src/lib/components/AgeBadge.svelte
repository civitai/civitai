<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { dateTime } from '$lib/format';
  import { OVERDUE_ITEM_DAYS, isOverdue } from '$lib/queue-thresholds';
  import ShortAge from './ShortAge.svelte';

  let { since }: { since: Date | string } = $props();

  const overdue = $derived(isOverdue(since));
  const title = $derived(
    `Waiting since ${dateTime(since)}${overdue ? ` (over ${OVERDUE_ITEM_DAYS} days)` : ''}`
  );
</script>

<!-- Text colour only: a red FILL is the Upheld verdict badge, which sits beside this one. -->
<Badge variant="secondary" {title} class={overdue ? 'font-semibold text-red-300' : ''}>
  <ShortAge at={since} {title} />{#if overdue}<span class="sr-only"> overdue</span>{/if}
</Badge>
