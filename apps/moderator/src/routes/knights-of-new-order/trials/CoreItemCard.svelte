<script lang="ts">
  import { enhance } from '$app/forms';
  import { browsingLevels, getBrowsingLevelLabel } from '@civitai/shared';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { imageLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, num } from '$lib/format';
  import type { CoreSetItem } from '$lib/server/knights/coreset.service';

  let { item, mode }: { item: CoreSetItem; mode: 'core' | 'fresh' } = $props();

  const level = $derived(Number(item.answer));
  const retired = $derived(item.status === 'retired');
  let selected = $state<number | null>(null);
  let why = $state<string | null>(null);
  const chosen = $derived(selected ?? level);
  const text = $derived(why ?? item.explanation ?? '');

  const save = new FormState({ reload: true, reset: false, onSuccess: () => toast.success('Saved') });
  const retire = new FormState({ reload: true, onSuccess: () => toast.success('Retired') });
  const promote = new FormState({ reload: true, onSuccess: () => toast.success('Added to the core set') });
</script>

<article class="flex flex-col gap-4 rounded-xl border border-dark-4 bg-dark-6 p-5 md:flex-row {retired ? 'opacity-60' : ''}">
  <a href={imageLookupUrl(item.imageId)} class="shrink-0 self-start">
    <EdgeMedia
      src={item.imageKey}
      name={item.imageName}
      type="image"
      width={240}
      alt="Image {item.imageId}"
      class="max-h-64 rounded-md"
    />
  </a>

  <div class="flex min-w-0 flex-1 flex-col gap-3">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <a href={imageLookupUrl(item.imageId)} class="font-medium {LINK_CLASS}">Image #{item.imageId}</a>
      <span class="text-sm text-dark-2">Answer: {getBrowsingLevelLabel(level)}</span>
      <span class="text-sm text-dark-2"
        >{num(item.answers)} answers, {num(item.failures)} missed</span
      >
      {#if item.flagged}<Badge variant="destructive">Players miss this far more than expected</Badge>{/if}
      {#if retired}<Badge variant="secondary">Retired</Badge>{/if}
      {#if mode === 'core' && !retired && !item.explanation}<Badge variant="outline">No explanation</Badge>{/if}
    </div>

    {#if mode === 'core'}
      {#if retired}
        <p class="text-sm text-dark-2">{item.explanation ?? 'No explanation.'} Add the image again to reinstate it.</p>
      {:else}
        {#if save.error}<p class="text-sm text-red-300">{save.error}</p>{/if}
        <form method="POST" action="?/update" use:enhance={save.enhance} class="flex flex-col gap-2">
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="level" value={chosen} />
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm text-dark-2">Answer</span>
            {#each browsingLevels as option (option)}
              <Button
                type="button"
                size="sm"
                variant={option === chosen ? 'secondary' : 'outline'}
                onclick={() => (selected = option)}>{getBrowsingLevelLabel(option)}</Button
              >
            {/each}
          </div>
          <Textarea name="explanation" rows={2} placeholder="Why this rating, shown to Acolytes after they answer" value={text} oninput={(e) => (why = e.currentTarget.value)} />
          <div>
            <Button type="submit" size="sm" disabled={save.submitting}>Save</Button>
          </div>
        </form>
      {/if}
    {:else}
      {#if promote.error}<p class="text-sm text-red-300">{promote.error}</p>{/if}
      <form method="POST" action="?/promote" use:enhance={promote.enhance} class="flex flex-col gap-2">
        <input type="hidden" name="id" value={item.id} />
        <Textarea name="explanation" rows={2} placeholder="Why this rating (optional now, add it later from the core set)" />
        <div>
          <Button type="submit" size="sm" disabled={promote.submitting}>Promote to core</Button>
        </div>
      </form>
    {/if}

    {#if !retired}
      {#if retire.error}<p class="text-sm text-red-300">{retire.error}</p>{/if}
      <form method="POST" action="?/retire" use:enhance={retire.enhance}>
        <input type="hidden" name="id" value={item.id} />
        <Button type="submit" size="sm" variant="outline" disabled={retire.submitting}>Retire</Button>
      </form>
    {/if}
  </div>
</article>
