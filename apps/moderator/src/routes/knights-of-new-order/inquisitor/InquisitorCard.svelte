<script lang="ts">
  import { enhance } from '$app/forms';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { imageLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { InquisitorItem } from '$lib/server/knights/inquisitor.service';

  let { item }: { item: InquisitorItem } = $props();

  const RATINGS = [1, 2, 4, 8, 16] as const;
  const BLOCKED = 32;

  const rule = new FormState({
    reload: true,
    onSuccess: () => toast.success('Rating set; the votes are graded'),
  });
  let confirmingBlocked = $state(false);
</script>

<article class="flex flex-col gap-4 rounded-xl border border-dark-4 bg-dark-6 p-5 md:flex-row">
  <a href={imageLookupUrl(item.imageId)} class="shrink-0 self-start">
    <EdgeMedia
      src={item.imageKey}
      name={item.imageName}
      type={item.imageType === 'video' ? 'video' : 'image'}
      width={320}
      alt="Image {item.imageId}"
      class="max-h-80 rounded-md"
    />
  </a>

  <div class="flex min-w-0 flex-1 flex-col gap-3">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <a href={imageLookupUrl(item.imageId)} class="font-medium {LINK_CLASS}">Image #{item.imageId}</a>
      <span class="text-sm text-dark-2">Currently {getBrowsingLevelLabel(item.currentLevel)}</span>
      {#if item.locked}<Badge variant="secondary">Rating locked</Badge>{/if}
      {#if item.reason}<Badge variant="outline">{item.reason}</Badge>{/if}
    </div>

    <p class="text-sm text-dark-2">
      {item.prompt} · from {item.source} · queued {dateTime(item.createdAt)}
    </p>

    {#if item.votes.length === 0}
      <p class="text-sm text-dark-2">No votes were cast.</p>
    {:else}
      <table class="w-full max-w-sm text-sm">
        <thead>
          <tr class="text-left text-xs text-dark-2">
            <th class="font-normal">Knights voted</th>
            <th class="text-right font-normal">Votes</th>
            <th class="text-right font-normal">Weight</th>
          </tr>
        </thead>
        <tbody>
          {#each item.votes as vote (vote.answer)}
            <tr>
              <td>{vote.label}</td>
              <td class="text-right">{num(vote.votes)}</td>
              <td class="text-right">{vote.weight.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    {#if rule.error}
      <p class="text-sm text-red-300">{rule.error}</p>
    {/if}

    <form method="POST" action="?/rule" use:enhance={rule.enhance} class="flex flex-wrap items-center gap-2">
      <input type="hidden" name="itemId" value={item.id} />
      <span class="text-sm text-dark-2">Final rating</span>
      {#each RATINGS as level (level)}
        <Button
          type="submit"
          name="level"
          value={level}
          size="sm"
          variant={level === item.currentLevel ? 'secondary' : 'outline'}
          disabled={rule.submitting}>{getBrowsingLevelLabel(level)}</Button
        >
      {/each}
      {#if confirmingBlocked}
        <Button
          type="submit"
          name="level"
          value={BLOCKED}
          size="sm"
          variant="destructive"
          disabled={rule.submitting}>Confirm Blocked</Button
        >
        <Button type="button" size="sm" variant="ghost" onclick={() => (confirmingBlocked = false)}
          >Cancel</Button
        >
      {:else}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={rule.submitting}
          onclick={() => (confirmingBlocked = true)}>Blocked</Button
        >
      {/if}
    </form>
  </div>
</article>
