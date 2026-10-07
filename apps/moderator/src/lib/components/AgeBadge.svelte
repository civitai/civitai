<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { dateTime, shortAge } from '$lib/format';
  import { isOverdue } from '$lib/queue-thresholds';

  let { since }: { since: Date | string } = $props();
</script>

<Badge
  variant="secondary"
  title={`Waiting since ${dateTime(since)}`}
  class={isOverdue(since) ? 'bg-red-500/20 text-red-200' : ''}
>
  {shortAge(since)}
</Badge>
