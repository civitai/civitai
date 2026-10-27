<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import ConfirmButton from '$lib/components/ConfirmButton.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { optimisticEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime, num, plural } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { DisputeResolution } from '$lib/server/creator-services-disputes.service';
  import { buyerFinalDownloads } from './downloads';
  import { disputeOrigin, viewerParty } from './origin';
  import type { DisputeCardRow, ResolveOutcome } from './+page.server';

  let {
    row,
    canResolve,
    viewerId,
    outcome,
  }: {
    row: DisputeCardRow;
    canResolve: boolean;
    viewerId: number | null;
    outcome: ResolveOutcome | null;
  } = $props();

  // Plain variable, read in enhance's submit hook. Do NOT route it through a hidden input: Svelte 5
  // writes DOM updates in a microtask while requestSubmit() builds the form data synchronously, so the
  // form would carry the PREVIOUS click's answer and a confirmed Release would post as Refund.
  let chosen: DisputeResolution = 'Refund';
  let formEl = $state<HTMLFormElement | null>(null);
  let pending = $state<DisputeResolution | null>(null);

  const origin = $derived(disputeOrigin(row));
  const amount = $derived(`${num(row.price)} ${row.buzzType} Buzz`);
  // The server's refusal is the authority; `finalsClear` only spares the moderator a round trip.
  const releaseBlocked = $derived(!row.finalsClear || !!outcome?.releaseRefused);
  // The main app refuses a party too; hiding the buttons only saves the round trip.
  const party = $derived(viewerParty(row, viewerId));
  const buyerDownloads = $derived(
    row.files ? buyerFinalDownloads(row.files, row, row.accessRecordedSince) : null
  );
  const firstTaken = $derived.by(() => {
    if (buyerDownloads?.state !== 'yes') return null;
    const when =
      buyerDownloads.beforeDispute === null
        ? ''
        : buyerDownloads.beforeDispute
          ? ', before the dispute'
          : ', after the dispute opened';
    const since = buyerDownloads.partial
      ? ` · recorded only since ${dateTime(row.accessRecordedSince)}`
      : '';
    return `first ${dateTime(buyerDownloads.firstAt)}${when}${since}`;
  });

  const choose = (value: DisputeResolution) => () => {
    chosen = value;
    formEl?.requestSubmit();
  };

  // A refused ruling must undo its dim, or the moderator believes the deal was settled.
  const submit = optimisticEnhancer(
    ({ formData }) => {
      formData.set('resolution', chosen);
      pending = chosen;
      return () => (pending = null);
    },
    { reload: true }
  );
</script>

<li
  class={cn(
    'rounded-lg border border-dark-4 bg-dark-6 p-4 transition-opacity',
    pending && 'opacity-50'
  )}
>
  <div class="flex flex-wrap items-baseline gap-x-2">
    <span class="font-medium">{row.offering.title}</span>
    <code class="text-xs text-dark-2">deal #{row.id}</code>
    <Badge variant="secondary">{amount}</Badge>
    <Badge variant={origin.system ? 'destructive' : 'outline'}>{origin.label}</Badge>
  </div>

  <p class="mt-1 text-xs text-dark-2">
    buyer
    <a href={userLookupUrl(row.buyer.id)} class={LINK_CLASS}>
      {row.buyer.username ?? `#${row.buyer.id}`}
    </a>
    · seller
    <a href={userLookupUrl(row.seller.id)} class={LINK_CLASS}>
      {row.seller.username ?? `#${row.seller.id}`}
    </a>
    {#if row.seller.unavailable}<Badge variant="outline">banned or deleted</Badge>{/if}
    · disputed {dateTime(row.disputeOpenedAt)} · {row.revisionsUsed} revisions used
  </p>

  {#if !origin.text && origin.code}
    <p class="mt-2 text-sm text-dark-0">
      Reason code: <code>{origin.code}</code>
      <span class="text-xs text-dark-2">(no text: the party chose a code only, or was muted)</span>
    </p>
  {/if}
  {#if origin.text}
    <p class="mt-2 rounded-md bg-dark-7 p-2 text-sm text-dark-0 whitespace-pre-wrap">
      {origin.text}
    </p>
  {/if}

  {#if buyerDownloads}
    <p class="mt-2 text-sm text-dark-0">
      Buyer downloaded the final:
      {#if buyerDownloads.state === 'yes'}
        yes, {dateTime(buyerDownloads.lastAt)}, {plural(buyerDownloads.count, 'time')}
        <span class="text-xs text-dark-2">· {firstTaken}</span>
      {:else if buyerDownloads.state === 'never'}
        No download recorded
      {:else if buyerDownloads.reason === 'before-recording'}
        <span class="text-dark-2">unknown (the deal completed before downloads were recorded)</span>
      {:else}
        <span class="text-dark-2">unknown (the download log could not be read)</span>
      {/if}
    </p>
    <p class="mt-1 text-xs text-dark-2">
      A download before the dispute counts toward releasing to the seller, unless the files are missing
      or broken.
    </p>
  {/if}

  <details class="mt-2">
    <summary class="cursor-pointer text-xs text-dark-2">
      Event log ({row.events.length})
    </summary>
    <ol class="mt-1 space-y-1 text-xs text-dark-1">
      {#each row.events as event (event.id)}
        <li>
          <span class="text-dark-2">{dateTime(event.createdAt)}</span>
          <span class="font-medium">{event.type}</span>
          <span class="text-dark-2">
            by {event.actorId === -1 ? 'system' : `#${event.actorId}`}
            {#if event.round}· round {event.round}{/if}
          </span>
          {#if event.reasonCode}<code class="text-dark-2">{event.reasonCode}</code>{/if}
          {#if event.comment}<span class="block whitespace-pre-wrap">{event.comment}</span>{/if}
        </li>
      {/each}
    </ol>
  </details>

  <details class="mt-2">
    <summary class="cursor-pointer text-xs text-dark-2">
      Files{row.filesError ? ' (could not load)' : row.files ? ` (${row.files.length})` : ''}
    </summary>
    {#if row.filesError}
      <ErrorAlert class="mt-1" message={row.filesError} />
    {:else if row.files?.length === 0}
      <p class="mt-1 text-xs text-dark-2">No files uploaded.</p>
    {:else}
      <ul class="mt-1 space-y-1 text-xs text-dark-1">
        {#each row.files ?? [] as file (file.id)}
          <li>
            <Badge variant="outline">{file.kind} r{file.round}</Badge>
            <!-- Not gated on canDownload: that is the buyer-and-seller rule (Ready finals only), while the
                 moderator link serves the original of any file, previews and unscanned finals included. -->
            <a
              href="/creator-services/disputes/files/{file.id}"
              target="_blank"
              rel="noreferrer"
              class={LINK_CLASS}>{file.fileName ?? `file #${file.id}`}</a
            >
            <span class="text-dark-2">
              {file.status} · scan {file.scanStatus}
              {#if file.failReason}· {file.failReason}{/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </details>

  {#if row.latestReview}
    {@const review = row.latestReview}
    <div class="mt-3 rounded-md bg-dark-7 p-2 text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium text-white">Agent review</span>
        <Badge variant="outline">{review.class}</Badge>
        <span class="text-dark-0">
          {review.proposal ? `Proposes ${review.proposal.toLowerCase()}` : 'Escalated to a human'}
        </span>
        {#if review.confidence !== null}
          <span class="text-xs text-dark-2">{Math.round(review.confidence * 100)}% confident</span>
        {/if}
        {#if review.mode === 'shadow'}<Badge variant="secondary">shadow</Badge>{/if}
      </div>
      <p class="mt-1 whitespace-pre-wrap text-dark-0">{review.rationale}</p>
      <p class="mt-1 text-xs text-dark-2">
        {review.agentVersion} · {dateTime(review.createdAt)}
      </p>
    </div>
  {/if}

  {#if outcome?.error}
    <ErrorAlert class="mt-3" message={outcome.error} />
  {/if}
  {#if canResolve && party}
    <p class="mt-3 text-xs text-dark-2">
      You are the {party} on this deal. Another moderator must resolve it.
    </p>
  {:else if canResolve}
    <form
      bind:this={formEl}
      method="POST"
      action="?/resolve"
      use:enhance={submit}
      class="mt-3 space-y-2"
    >
      <input type="hidden" name="dealId" value={row.id} />
      <div>
        <Label for="note-{row.id}" class="text-xs text-dark-2">
          Note (shown to both parties)
        </Label>
        <Textarea id="note-{row.id}" name="note" maxlength={1000} rows={2} />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <ConfirmButton
          size="xs"
          label="Refund buyer"
          title="Refund {amount}?"
          description="Returns {amount} to {row.buyer.username ?? `user #${row.buyer.id}`} and cancels the deal."
          disabled={!!pending}
          onconfirm={choose('Refund')}
        />
        {#if !releaseBlocked}
          <ConfirmButton
            size="xs"
            label="Release to seller"
            title="Release {amount}?"
            description="Pays {amount} to {row.seller.username ?? `user #${row.seller.id}`} and completes the deal."
            disabled={!!pending}
            onconfirm={choose('Release')}
          />
        {:else}
          <span class="text-xs text-dark-2">
            Release unavailable: the final files have not passed scanning. Refund, or clear the file in
            moderation first.
          </span>
        {/if}
      </div>
    </form>
  {:else}
    <p class="mt-3 text-xs text-dark-2">
      Resolving needs the “Resolve a Creator Services dispute” permission.
    </p>
  {/if}
</li>
