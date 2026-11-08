<script lang="ts">
  import { browser } from '$app/environment';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { civitaiUrl } from '$lib/model-url';
  import type { GiftClaimsPage } from '../gift-links';

  let {
    versionId,
    target,
  }: { versionId: number; target: { giftId: number } | { batchId: string } } = $props();

  let open = $state(false);
  // Each entry is the cursor a page was fetched with; the last is the page shown.
  let cursors = $state<(string | null)[]>([null]);
  // Bumped by Retry: the page promise reads it, so the same cursor is fetched again.
  let attempt = $state(0);
  // Sent with the first page only, and shown on the last.
  let hidden = $state(0);

  const base = $derived(
    `/models/gifts/${versionId}/claims?` +
      ('giftId' in target ? `giftId=${target.giftId}` : `batchId=${target.batchId}`)
  );
  const cursor = $derived(cursors[cursors.length - 1]);
  const page = $derived<Promise<GiftClaimsPage>>(
    browser && open && attempt >= 0
      ? fetch(`${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).then(async (r) => {
          if (!r.ok)
            throw new Error((await r.json().catch(() => null))?.message ?? 'Request failed.');
          const data: GiftClaimsPage = await r.json();
          if (data.hiddenCount !== null) hidden = data.hiddenCount;
          return data;
        })
      : new Promise(() => {})
  );
</script>

<div class="w-full">
  <button
    type="button"
    class="text-xs text-dark-2 hover:text-white"
    aria-expanded={open}
    onclick={() => {
      open = !open;
      cursors = [null];
    }}
  >
    {open ? 'Hide claimers' : 'Show claimers'}
  </button>
  {#if open}
    {#await page}
      <p class="mt-2 text-xs text-dark-2">Loading…</p>
    {:then result}
      {#if result.claims.length === 0 && hidden === 0}
        <p class="mt-2 text-xs text-dark-2">Nobody has claimed it yet.</p>
      {:else}
        <ul class="mt-2 flex flex-col gap-1 text-xs">
          {#each result.claims as claim (`${claim.giftLinkId}:${claim.userId}`)}
            <li class="flex justify-between gap-3">
              {#if claim.username}
                <a
                  href={civitaiUrl(`user/${encodeURIComponent(claim.username)}`, {})}
                  target="_blank"
                  rel="noopener"
                  class="text-dark-0 hover:text-white">{claim.username}</a
                >
              {:else}
                <span class="text-dark-2">An account with no username</span>
              {/if}
              <span class="text-dark-2">{new Date(claim.claimedAt).toLocaleDateString()}</span>
            </li>
          {/each}
        </ul>
        {#if hidden > 0 && !result.nextCursor}
          <p class="mt-1 text-xs text-dark-2">
            {hidden} earlier {hidden === 1 ? 'claim' : 'claims'} (names hidden)
          </p>
        {/if}
      {/if}
      <div class="mt-2 flex gap-2">
        {#if cursors.length > 1}
          <Button size="sm" variant="ghost" onclick={() => (cursors = cursors.slice(0, -1))}>
            Newer
          </Button>
        {/if}
        {#if result.nextCursor}
          <Button
            size="sm"
            variant="ghost"
            onclick={() => (cursors = [...cursors, result.nextCursor])}
          >
            Older
          </Button>
        {/if}
      </div>
    {:catch err}
      <p class="mt-2 text-xs text-red-4">Couldn't load claimers: {err.message}</p>
      <Button
        size="sm"
        variant="ghost"
        onclick={() => (cursors.length > 1 ? (cursors = cursors.slice(0, -1)) : attempt++)}
      >
        {cursors.length > 1 ? 'Newer' : 'Retry'}
      </Button>
    {/await}
  {/if}
</div>
