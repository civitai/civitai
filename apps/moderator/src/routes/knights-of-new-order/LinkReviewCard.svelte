<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { LinkReview } from '$lib/server/knights/link-review.service';

  let { review }: { review: LinkReview } = $props();

  const block = new FormState({
    reload: true,
    onSuccess: () => toast.success('Payouts held'),
  });
  const clear = new FormState({
    reload: true,
    onSuccess: () => toast.success('Cleared; payouts will be released'),
  });
  const error = $derived(block.error ?? clear.error);
</script>

<article class="flex flex-col gap-3 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <p class="text-sm text-dark-2">
      {review.members.length} accounts · {num(review.buzzMoved)} Buzz moved between them · found
      {dateTime(review.createdAt)}
    </p>
    <div class="flex flex-wrap gap-1.5">
      {#if review.autoBlocked}<Badge variant="destructive">Held automatically</Badge>{/if}
      {#if review.status === 'Cleared'}<Badge variant="secondary">Cleared</Badge>{/if}
    </div>
  </div>

  <ul class="flex flex-col gap-1 text-sm">
    {#each review.lines as line, i (i)}
      <li>{line}</li>
    {/each}
  </ul>

  <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-dark-2">
    {#each review.members as member (member.userId)}
      <li>
        <a href={userLookupUrl(member.username ?? member.userId)} class={LINK_CLASS}
          >{member.username ?? `#${member.userId}`}</a
        >
        {#if member.createdAt}· joined {dateTime(member.createdAt)}{/if}
        {#if member.banned}· banned{/if}
        {#if member.payoutBlockedAt}· payouts held{/if}
      </li>
    {/each}
  </ul>

  {#if error}
    <p class="text-sm text-red-300">{error}</p>
  {/if}

  <div class="flex gap-2">
    {#if review.status === 'Pending'}
      <form method="POST" action="?/block" use:enhance={block.enhance}>
        <input type="hidden" name="id" value={review.id} />
        <Button type="submit" size="sm" variant="destructive" disabled={block.submitting}
          >Block payouts</Button
        >
      </form>
    {/if}
    {#if review.status !== 'Cleared'}
      <form method="POST" action="?/clear" use:enhance={clear.enhance}>
        <input type="hidden" name="id" value={review.id} />
        <Button type="submit" size="sm" variant="outline" disabled={clear.submitting}>Clear</Button>
      </form>
    {/if}
  </div>
</article>
