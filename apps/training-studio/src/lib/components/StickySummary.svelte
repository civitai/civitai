<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children, footer }: { children: Snippet; footer?: Snippet } = $props();
</script>

<!-- The wizard's right-hand summary panel. The height cap sits on the sticky wrapper so a footer
     stays on screen beside a long panel; the panel scrolls instead. -->
<div class="sticky top-4 flex h-fit max-h-[calc(100dvh-2rem)] flex-col">
  <aside class="min-h-0 overflow-y-auto rounded-xl border border-dark-4 bg-dark-6 p-5">
    {@render children()}
  </aside>
  {@render footer?.()}
</div>
