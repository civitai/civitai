<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';

  /**
   * The app's refusal banner. It was hand-rolled at 38 sites across 30 files — every one of them the
   * same six classes plus `role="alert"`, differing only in margin.
   *
   * 🔴 This deliberately reproduces that markup EXACTLY rather than adopting `@civitai/ui`'s `alert`
   * primitive. The primitive has its own padding, structure and palette, so swapping to it would
   * restyle 38 refusal messages across pages nobody can look at in one pass — a visual change wearing
   * the clothes of a refactor. Moving to the primitive is a separate, deliberate decision; collapsing
   * 38 copies into one definition is what makes that decision a single edit when someone takes it.
   *
   * `class` carries the caller's margin, which is the only thing that ever varied.
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
    'rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300',
    className
  )}
  role="alert"
>
  {message}
</div>
