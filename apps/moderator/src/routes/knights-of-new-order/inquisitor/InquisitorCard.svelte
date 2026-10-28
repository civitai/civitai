<script lang="ts">
  import { enhance } from '$app/forms';
  import { browsingLevels, getBrowsingLevelLabel, NsfwLevel } from '@civitai/shared';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { imageLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { InquisitorItem } from '$lib/server/knights/inquisitor.service';

  let { item }: { item: InquisitorItem } = $props();

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
      {#if item.blocked}
        <Badge variant="destructive">Blocked{item.blockedFor ? ` (${item.blockedFor})` : ''}</Badge>
      {/if}
      {#if item.locked}<Badge variant="secondary">Rating locked</Badge>{/if}
      {#if item.reason}<Badge variant="outline">{item.reason}</Badge>{/if}
    </div>

    <p class="text-sm text-dark-2">
      {item.prompt} · from {item.source} · queued {dateTime(item.createdAt)}
    </p>

    {#if item.votes.length === 0}
      <p class="text-sm text-dark-2">No votes were cast.</p>
    {:else}
      <Table class="max-w-sm">
        <TableHeader>
          <TableRow>
            <TableHead>Knights voted</TableHead>
            <TableHead class="text-right">Votes</TableHead>
            <TableHead class="text-right">Weight</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each item.votes as vote (vote.answer)}
            <TableRow>
              <TableCell>{vote.label}</TableCell>
              <TableCell class="text-right">{num(vote.votes)}</TableCell>
              <TableCell class="text-right"
                >{vote.weight.toLocaleString(undefined, { maximumFractionDigits: 1 })}</TableCell
              >
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    {/if}

    {#if item.blocked}
      <p class="text-sm text-amber-300">
        This image is blocked and rating it does not unblock it. Rule Blocked, or restore it from the
        image queue first.
      </p>
    {/if}

    {#if rule.error}
      <p class="text-sm text-red-300">{rule.error}</p>
    {/if}

    <form method="POST" action="?/rule" use:enhance={rule.enhance} class="flex flex-wrap items-center gap-2">
      <input type="hidden" name="itemId" value={item.id} />
      <span class="text-sm text-dark-2">Final rating</span>
      {#each browsingLevels as level (level)}
        <Button
          type="submit"
          name="level"
          value={level}
          size="sm"
          variant={level === item.currentLevel ? 'secondary' : 'outline'}
          disabled={rule.submitting || item.blocked}>{getBrowsingLevelLabel(level)}</Button
        >
      {/each}
      {#if confirmingBlocked}
        <Button
          type="submit"
          name="level"
          value={NsfwLevel.Blocked}
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
