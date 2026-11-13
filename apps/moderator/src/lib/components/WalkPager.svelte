<!-- Previous / Next over a keyset cursor walk. Unlike CursorPager (a link to the next page) this pages
     in place, so Previous is the caller's index move back through the cursors it has walked. -->
<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { num } from '$lib/format';

  let {
    index,
    hasNext,
    onBack,
    onNext,
  }: { index: number; hasNext: boolean; onBack: () => void; onNext: () => void } = $props();
</script>

{#if index > 0 || hasNext}
  <div class="mt-3 flex items-center gap-2">
    <Button size="xs" variant="outline" disabled={index === 0} onclick={onBack}>Previous</Button>
    <span class="text-xs text-dark-2">Page {num(index + 1)}</span>
    <Button size="xs" variant="outline" disabled={!hasNext} onclick={onNext}>Next</Button>
  </div>
{/if}
