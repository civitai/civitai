<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { IconExternalLink, IconSearch, IconUser } from '@tabler/icons-svelte';
  import { page } from '$app/state';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { ratingReviewEntityLabels, ratingReviewLevelLabel } from '@civitai/shared/rating-review';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import ReportDetailColumns from '$lib/components/report-queue/ReportDetailColumns.svelte';
  import TriageDetailHeader from '$lib/components/triage/TriageDetailHeader.svelte';
  import { userUrl } from '$lib/entity-url';
  import { getEdgeUrl } from '$lib/media/edge-url';
  import { LINK_BUTTON, dateTime, ordinal, shortAge } from '$lib/format';
  import { disputeTitle, imageCaption, isNsfwRating } from '$lib/rating-dispute';
  import { ratingReviewStatusBadge } from '$lib/rating-review';
  import type { RatingDisputeRow } from '$lib/server/rating-dispute-queue';
  import type { Outcome } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import RatingDecisionForm from './RatingDecisionForm.svelte';
  import ScannedTextCard from './ScannedTextCard.svelte';

  let {
    row,
    civitaiUrl,
    verdict,
    error,
    submit,
    actionHref,
    chosen = $bindable(),
  }: {
    row: RatingDisputeRow;
    civitaiUrl: string;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    chosen: number | null;
  } = $props();

  const type = $derived(row.entityType);
  const typeLabel = $derived(ratingReviewEntityLabels[type]);
  const levelLabel = (level: number | null | undefined) => ratingReviewLevelLabel(type, level);
  const title = $derived(disputeTitle(type, row.entityId, row.entity));
  const status = $derived(ratingReviewStatusBadge[row.status]);
  const pending = $derived(row.status === 'Pending');
  const owner = $derived(row.user.username ?? `User #${row.user.id}`);
  const caption = $derived(imageCaption(type, row.preview.total));
  const resolver = $derived(
    row.resolver ? (row.resolver.username ?? `User #${row.resolver.id}`) : null
  );
  const disputesHref = $derived(
    urlWith(page.url, {
      owner: row.user.id,
      q: null,
      status: null,
      sort: null,
      page: null,
      selected: null,
    })
  );
</script>

{#snippet statusBadge()}
  {#if status}
    <span class="rounded px-1.5 py-px text-[11px] font-semibold {status.class}">
      {status.label}
    </span>
  {/if}
{/snippet}

{#snippet levelCard(heading: string, value: string, sub: string, accent: 'blue' | 'amber' | undefined = undefined, muted = false)}
  <TriageCard title={heading} dense {accent}>
    <p class="m-0 text-xl font-semibold {muted ? 'text-dark-2' : 'text-white'}">{value}</p>
    <p class="m-0 mt-0.5 text-xs text-dark-2">{sub}</p>
  </TriageCard>
{/snippet}

<!-- `data-triage-actions` is where `TriageShell` puts focus after a refusal. -->
{#snippet decision()}
  {#if error}<ErrorAlert class="mb-3" message={error} />{/if}
  <div data-triage-actions class="flex flex-col gap-2">
    <!-- No whitespace inside: `empty:` must match while there is no verdict. -->
    <div role="status" class="text-base font-medium text-white empty:sr-only">{#if verdict}{verdict}{/if}</div>
    {#if !verdict}<RatingDecisionForm {row} {submit} {actionHref} bind:chosen />{/if}
  </div>
{/snippet}

<!-- The report queues' columns (`ReportDetailColumns`): what is being rated in the middle, under the
     dispute's header; the levels, the owner's case and the ruling in the sidebar. Below `xl` they
     stack and the pane scrolls as one. -->
<div class="flex min-h-0 flex-1 flex-col overflow-y-auto xl:overflow-hidden">
  <ReportDetailColumns footer={pending ? decision : undefined}>
    {#snippet header()}
      <div class="space-y-2">
        <TriageDetailHeader {title} reference="#{row.entityId}" linksBeside>
          {#snippet chips()}
            <span class="rounded bg-dark-5 px-1.5 py-px text-[11px] font-semibold text-white">
              {typeLabel}
            </span>
            {@render statusBadge()}
            {#if !row.entity}<span class="text-xs text-dark-2 italic">Deleted</span>{/if}
          {/snippet}
          {#snippet links()}
            {#if row.entity?.path}
              <Button
                variant="outline"
                size="sm"
                class={LINK_BUTTON}
                href={civitaiUrl + row.entity.path}
                target="_blank"
                rel="noreferrer"
              >
                <IconExternalLink aria-hidden="true" /> Open {typeLabel.toLowerCase()}
              </Button>
            {/if}
            {#if row.user.username}
              <Button
                variant="outline"
                size="sm"
                class={LINK_BUTTON}
                href={userUrl(civitaiUrl, row.user.username)}
                target="_blank"
                rel="noreferrer"
              >
                <IconUser aria-hidden="true" /> Owner
              </Button>
            {/if}
            <Button variant="outline" size="sm" class={LINK_BUTTON} href={disputesHref}>
              <IconSearch aria-hidden="true" /> Owner's disputes
            </Button>
          {/snippet}
        </TriageDetailHeader>
        <p class="m-0 text-sm text-dark-2">
          by {owner}
          {#if row.createdAt}
            · disputed <span title={dateTime(row.createdAt)}>{shortAge(row.createdAt)} ago</span>
          {/if}
          {#if row.preview.total > 0}
            · {row.preview.total}
            {row.preview.total === 1 ? 'image' : 'images'}
          {/if}
          · {ordinal(row.ownerDisputeCount)} dispute
          {#if row.resolvedAt}
            · ruled <span title={dateTime(row.resolvedAt)}>{shortAge(row.resolvedAt)} ago</span>
            {#if resolver}by {resolver}{/if}
          {/if}
        </p>
      </div>
    {/snippet}

    {#snippet evidence()}
      <div class="space-y-5">
        <section aria-label="Images" class="space-y-2">
          <div class="flex flex-wrap items-baseline gap-x-3">
            <h3 class="m-0 text-[11px] font-semibold tracking-[0.5px] text-dark-2">{caption.title}</h3>
            {#if caption.hint}<span class="text-xs text-dark-2">{caption.hint}</span>{/if}
          </div>
          {#if row.preview.images.length}
            <!-- The middle column has the width for a grid, so every image is in view at once. -->
            <ul class="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2.5 p-0">
              {#each row.preview.images as img, i (img.id)}
                {@const nsfw = isNsfwRating(img.nsfwLevel)}
                {@const media = img.type === 'video' ? 'video' : 'image'}
                <li
                  class={cn(
                    'relative aspect-[4/5] overflow-hidden rounded-lg border bg-dark-6',
                    nsfw ? 'border-amber-500' : 'border-dark-4'
                  )}
                >
                  <a
                    href={getEdgeUrl(img.url, { type: media, original: true })}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open {media} {i + 1} of {row.preview.images.length} full size"
                    class="block size-full"
                  >
                    <EdgeMedia
                      src={img.url}
                      type={img.type}
                      anim={img.type === 'video' ? false : undefined}
                      width={450}
                      class="size-full object-cover object-top"
                    />
                  </a>
                  <span
                    class={cn(
                      'pointer-events-none absolute bottom-2 left-2 rounded px-1.5 py-px text-[10px] font-semibold',
                      nsfw ? 'bg-amber-500 text-black' : 'bg-black/60 text-white'
                    )}
                  >
                    {getBrowsingLevelLabel(img.nsfwLevel)}
                  </span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="m-0 text-sm text-dark-2">No images</p>
          {/if}
        </section>

        {#if row.scannedText}
          {#key row.id}
            <ScannedTextCard text={row.scannedText} entityLabel={typeLabel.toLowerCase()} />
          {/key}
        {/if}
      </div>
    {/snippet}

    {#snippet actions()}
      <div class="grid grid-cols-3 gap-2">
        {@render levelCard('Current', levelLabel(row.currentLevel), 'current rating')}
        {@render levelCard('Owner asks', levelLabel(row.suggestedLevel), 'approving applies this', 'blue')}
        {#if row.scan}
          {@render levelCard('Text scan', levelLabel(row.scan.level), 'raised by the text scan', 'amber')}
        {:else}
          {@render levelCard('Text scan', 'None', 'nothing raised', undefined, true)}
        {/if}
      </div>

      {#if row.scan?.reason}
        <TriageCard title="Why the scan raised it" dense accent="amber">
          <p class="m-0 wrap-anywhere whitespace-pre-wrap text-dark-0">{row.scan.reason}</p>
        </TriageCard>
      {/if}

      {#if row.userComment}
        <TriageCard title="Owner comment" dense>
          <p class="m-0 wrap-anywhere whitespace-pre-wrap text-dark-0">{row.userComment}</p>
        </TriageCard>
      {:else}
        <p class="m-0 text-sm text-dark-2">No comment from owner</p>
      {/if}

      {#if !pending}
        <TriageCard title="Resolution" dense>
          <div class="space-y-1.5 text-dark-0">
            <p class="m-0 flex flex-wrap items-center gap-2">
              {@render statusBadge()}
              {#if row.appliedLevel !== null}
                Applied {levelLabel(row.appliedLevel)} (owner asked {levelLabel(row.suggestedLevel)})
              {/if}
            </p>
            <p class="m-0 text-dark-2">
              {resolver ?? 'Auto-approved'}
              {#if row.resolvedAt}· {dateTime(row.resolvedAt)}{/if}
            </p>
            {#if row.modComment}
              <p class="m-0 wrap-anywhere whitespace-pre-wrap">Note to owner: {row.modComment}</p>
            {/if}
          </div>
        </TriageCard>
      {/if}
    {/snippet}
  </ReportDetailColumns>
</div>
