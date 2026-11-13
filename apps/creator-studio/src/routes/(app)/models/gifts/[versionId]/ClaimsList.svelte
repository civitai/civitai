<script lang="ts">
  import { browser } from '$app/environment';
  import { ConfirmButton } from '@civitai/ui/components/confirm/index.js';
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
  let removing = $state<string | null>(null);
  let removeError = $state<{ key: string; message: string } | null>(null);

  const claimKey = (c: { giftLinkId: number; userId: number }) => `${c.giftLinkId}:${c.userId}`;

  async function remove(claim: { giftLinkId: number; userId: number }) {
    const key = claimKey(claim);
    removing = key;
    removeError = null;
    try {
      const r = await fetch(
        `/models/gifts/${versionId}/claims?giftId=${claim.giftLinkId}&userId=${claim.userId}`,
        { method: 'DELETE' }
      );
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? 'Request failed.');
      attempt++;
    } catch (err) {
      removeError = { key, message: err instanceof Error ? err.message : 'Request failed.' };
    } finally {
      removing = null;
    }
  }

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
          {#each result.claims as claim (claimKey(claim))}
            {@const key = claimKey(claim)}
            <li class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
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
              <span class="ml-auto text-dark-2">
                {new Date(claim.claimedAt).toLocaleDateString()}
              </span>
              {#if claim.revokedAt}
                <span class="text-dark-2">Access removed</span>
              {:else}
                <span class="flex items-center gap-2">
                  <ConfirmButton
                    label="Remove"
                    title="Remove gifted access?"
                    description="They lose what this gift granted, unless another gift or a purchase covers it. The slot stays used, and they can't claim this link again."
                    disabled={removing === key}
                    onconfirm={() => remove(claim)}
                  />
                  <span class="text-dark-2">frees no slot</span>
                </span>
              {/if}
              {#if removeError?.key === key}
                <p class="w-full text-red-4">Couldn't remove: {removeError.message}</p>
              {/if}
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
