<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import RulingForm, { emptyRulingDraft, type RulingDraft } from '$lib/components/RulingForm.svelte';
  import { optimisticEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { FLAG_APPEAL_RULING_CHOICES } from '$lib/ruling-choices';
  import type { ActionData, PageData } from './$types';

  type Verdict = ResolutionVerdict<'flagAppeal'>;

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const acted = new SvelteMap<number, string>();
  // Held here, not in the form: the row swaps to its verdict on submit and back on a refusal.
  const drafts = new SvelteMap<number, RulingDraft<Verdict>>();
  $effect(() => {
    const open = new Set(data.items.map((row) => row.bountyId));
    acted.clear();
    // Untracked: typing a reason must not re-run this and wipe the marks.
    untrack(() => {
      for (const bountyId of drafts.keys()) if (!open.has(bountyId)) drafts.delete(bountyId);
    });
  });

  const keepUnavailable = (poi: boolean) => (verdict: Verdict) =>
    verdict === 'Rejected' && !poi ? 'No longer flagged. Unflag closes the request.' : null;

  const refusal = $derived.by(() => {
    if (!form || !('error' in form) || !form.error) return null;
    const bountyId = 'bountyId' in form ? form.bountyId : undefined;
    return bountyId ? `Bounty #${bountyId}: ${form.error}` : form.error;
  });

  // A refused verdict must undo its mark, or a moderator believes they ruled on an appeal that
  // is still open.
  const submit = (bountyId: number) =>
    optimisticEnhancer(
      ({ formData }) => {
        acted.set(
          bountyId,
          formData.get('status') === 'Rejected' ? 'Appeal rejected' : 'Appeal approved'
        );
        return () => acted.delete(bountyId);
      },
      { reload: true }
    );
</script>

<header class="page-header">
  <h1>Bounty Real-Person Appeals</h1>
</header>

{#if refusal}
  <ErrorAlert class="mb-4" message={refusal} />
{/if}

{#if form && 'rescanQueued' in form && form.rescanQueued}
  <p class="mb-4 rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-200">
    Bounty #{form.bountyId}: the owner edited the text while the appeal was open, so it will be
    scanned again.
  </p>
{/if}

{#if data.hasMore}
  <p class="mb-2 text-xs text-dark-2">Showing the oldest {data.limit} open appeals.</p>
{/if}

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">No open appeals against a real-person flag.</p>
{:else}
  <ul class="space-y-2">
    {#each data.items as row (row.bountyId)}
      {@const verdict = acted.get(row.bountyId)}
      <li
        class={cn(
          'rounded-lg border border-dark-4 bg-dark-6 p-4 transition-opacity',
          verdict && 'opacity-50'
        )}
      >
        <div class="flex flex-wrap items-baseline gap-x-2">
          <a
            href={`${data.civitaiUrl}/bounties/${row.bountyId}`}
            target="_blank"
            rel="noreferrer"
            class="font-medium {LINK_CLASS}"
          >
            {row.bountyName}
          </a>
          <code class="text-xs text-dark-2">#{row.bountyId}</code>
          <Badge variant="secondary">{row.availability}</Badge>
          {#if !row.poi}
            <Badge variant="outline">no longer flagged</Badge>
          {/if}
          {#if row.username && row.userId}
            <a href={userLookupUrl(row.userId)} class="text-xs {LINK_CLASS}">{row.username}</a>
          {/if}
          {#if row.textScanPoi?.at}
            <span class="text-xs text-dark-2">flagged {dateTime(row.textScanPoi.at)}</span>
          {/if}
        </div>

        {#if row.textScanPoi?.reason}
          <p class="mt-2 text-sm text-dark-0">{row.textScanPoi.reason}</p>
        {/if}
        {#if row.textScanPoi?.names?.length}
          <p class="mt-1 text-xs text-dark-2">Names: {row.textScanPoi.names.join(', ')}</p>
        {/if}

        <p class="mt-2 rounded-md bg-dark-7 p-2 text-sm text-dark-0">{row.appealMessage}</p>
        <p class="mt-1 text-xs text-dark-2">appealed {dateTime(row.appealCreatedAt)}</p>
        <!-- At expiry a bounty still hidden is refunded, never awarded. -->
        <p class="mt-1 text-xs text-dark-2">
          expires {dateTime(row.expiresAt)} ·
          <a
            href={`${data.civitaiUrl}/bounties/${row.bountyId}`}
            target="_blank"
            rel="noreferrer"
            class={LINK_CLASS}
          >
            delete or refund from the bounty's menu
          </a>
        </p>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          {#if verdict}
            <span class="text-sm text-dark-2">{verdict}</span>
          {:else}
            <RulingForm
              subject="flagAppeal"
              choices={FLAG_APPEAL_RULING_CHOICES}
              choiceDisabled={keepUnavailable(row.poi)}
              labels={['poi']}
              action="?/resolve"
              enhancer={submit(row.bountyId)}
              idPrefix="bounty-poi-{row.bountyId}"
              size="xs"
              bind:draft={() => drafts.get(row.bountyId) ?? emptyRulingDraft<Verdict>(),
                (d: RulingDraft<Verdict>) => drafts.set(row.bountyId, d)}
            >
              {#snippet hidden()}
                <input type="hidden" name="bountyId" value={row.bountyId} />
              {/snippet}
            </RulingForm>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}
