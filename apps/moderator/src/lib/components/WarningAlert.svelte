<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';

  /**
   * The amber banner for an action that worked with something to know. `class` carries the caller's
   * margin.
   */
  let {
    message,
    class: className = '',
  }: {
    message: string;
    class?: string;
  } = $props();
</script>

<div
  class={cn(
    'rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200',
    className
  )}
  role="status"
>
  {message}
</div>
