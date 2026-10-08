<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { dateTime, shortAge } from '$lib/format';
  import { OVERDUE_ITEM_DAYS, isOverdue } from '$lib/queue-thresholds';

  let { since }: { since: Date | string } = $props();

  const overdue = $derived(isOverdue(since));
</script>

<!-- Text colour only: a red FILL is the Upheld verdict badge, which sits beside this one. -->
<Badge
  variant="secondary"
  title={`Waiting since ${dateTime(since)}${overdue ? ` (over ${OVERDUE_ITEM_DAYS} days)` : ''}`}
  class={overdue ? 'font-semibold text-red-300' : ''}
>
  {shortAge(since)}{#if overdue}<span class="sr-only"> overdue</span>{/if}
</Badge>
