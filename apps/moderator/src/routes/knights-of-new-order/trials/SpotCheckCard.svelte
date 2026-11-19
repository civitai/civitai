<script lang="ts">
  import { enhance } from '$app/forms';
  import { browsingLevels, getBrowsingLevelLabel } from '@civitai/shared';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import type { SpotCheckItem } from '$lib/server/knights/coreset.service';

  let { item }: { item: SpotCheckItem } = $props();

  const rate = new FormState({
    reload: true,
    onSuccess: (data) =>
      data?.agreed
        ? toast.success('Matches: it goes into Trials')
        : toast.info('Does not match: it stays out'),
  });
</script>

<!-- The image is deliberately not linked: its page shows the rating this check is blind to. -->
<article class="flex flex-col gap-4 rounded-xl border border-dark-4 bg-dark-6 p-5 md:flex-row">
  <EdgeMedia src={item.imageKey} width={320} alt="Image to rate" class="max-h-80 shrink-0 self-start rounded-md" />
  <div class="flex min-w-0 flex-1 flex-col gap-3">
    {#if rate.error}<ErrorAlert message={rate.error} />{/if}
    <form method="POST" action="?/spotCheck" use:enhance={rate.enhance} class="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={item.id} />
      <span class="text-sm text-dark-2">Your rating</span>
      {#each browsingLevels as level (level)}
        <Button type="submit" name="level" value={level} size="sm" variant="outline" disabled={rate.submitting}
          >{getBrowsingLevelLabel(level)}</Button
        >
      {/each}
    </form>
  </div>
</article>
