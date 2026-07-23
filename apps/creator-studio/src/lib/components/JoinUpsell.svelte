<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';

  // Compact upsell for gated controls (fee-setting, sell-indefinitely). Links to /join, the Studio's
  // acquisition surface, which carries the full pitch + the external Creator Program CTA. Copy defaults are
  // generic; pass `body` to make it contextual to the control being gated.
  let {
    title = 'Creator Program members only',
    body = 'Join the Creator Program to set licensing fees and sell access to your models.',
    cta = 'Learn more',
    class: className = '',
  }: { title?: string; body?: string; cta?: string; class?: string } = $props();
</script>

<div
  class={`flex flex-wrap items-center gap-3 rounded-lg border border-dark-4 bg-dark-6 p-4 ${className}`}
>
  <div class="min-w-0 flex-1">
    <p class="text-sm font-medium text-white">{title}</p>
    <p class="text-sm text-dark-2">{body}</p>
  </div>
  <Button href="/join" variant="secondary" size="sm">{cta}</Button>
</div>
