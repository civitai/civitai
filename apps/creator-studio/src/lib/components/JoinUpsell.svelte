<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';

  // Compact upsell for tier-capped controls. Links to /join, the Studio's acquisition surface, which
  // carries the full pitch + the external Creator Program CTA.
  let {
    title,
    body = 'Fees and paid access are open to everyone. A membership raises how many new prices you can set each month.',
    cta = 'See tiers',
    class: className = '',
  }: { title?: string; body?: string; cta?: string; class?: string } = $props();
</script>

<div
  class={`flex flex-wrap items-center gap-3 rounded-lg border border-dark-4 bg-dark-6 p-4 ${className}`}
>
  <div class="min-w-0 flex-1">
    {#if title}
      <p class="text-sm font-medium text-white">{title}</p>
    {/if}
    <p class="text-sm text-dark-2">{body}</p>
  </div>
  <Button href="/join" variant="secondary" size="sm">{cta}</Button>
</div>
