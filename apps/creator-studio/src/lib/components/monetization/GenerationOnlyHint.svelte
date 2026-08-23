<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';
  import { CIVITAI_MEMBERSHIP_URL } from '$lib/creator-program';
  import { GENERATION_ONLY_HINT_LEAD, GENERATION_ONLY_HINT_LINK } from '$lib/monetization/paid-access';

  let { class: className = '' }: { class?: string } = $props();
</script>

<p class={cn('text-xs text-dark-2', className)}>
  {GENERATION_ONLY_HINT_LEAD}
  <a href={CIVITAI_MEMBERSHIP_URL} class="underline">{GENERATION_ONLY_HINT_LINK}</a>.
</p>
