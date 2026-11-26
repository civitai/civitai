<script lang="ts">
  import type { Snippet } from 'svelte';
  import '$lib/civitai-elements';
  import { useElementsUi } from '$lib/elements-ui';

  let {
    children,
    footer,
    class: className = '',
  }: { children: Snippet; footer?: Snippet; class?: string } = $props();
  const elementsUi = useElementsUi();
</script>

<!-- The wizard's right-hand summary panel. From lg it is sticky, and the height cap sits on the sticky
     wrapper so a footer stays on screen beside a long panel; the panel scrolls instead. Below lg it
     flows with the page. -->
<div class="flex h-fit flex-col lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] {className}">
  {#if elementsUi()}
    <aside class="min-h-0 lg:overflow-y-auto">
      <civitai-card padding="lg" with-border>
        {@render children()}
      </civitai-card>
    </aside>
  {:else}
    <aside class="min-h-0 rounded-xl border border-dark-4 bg-dark-6 p-5 lg:overflow-y-auto">
      {@render children()}
    </aside>
  {/if}
  {@render footer?.()}
</div>
