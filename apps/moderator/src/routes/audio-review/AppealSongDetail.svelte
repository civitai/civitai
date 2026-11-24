<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { IconExternalLink, IconSearch, IconUser } from '@tabler/icons-svelte';
  import { reasonRequiresNote, resolutionReasonsFor } from '@civitai/shared/resolution-reasons';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import CdnOrRetractedMedia from '$lib/components/image-queue/CdnOrRetractedMedia.svelte';
  import SongBadge from '$lib/components/SongBadge.svelte';
  import SongCard from '$lib/components/SongCard.svelte';
  import InlineReasonFields from '$lib/components/triage/InlineReasonFields.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageColumns from '$lib/components/triage/TriageColumns.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageDetailHeader from '$lib/components/triage/TriageDetailHeader.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import {
    appealDecisionsEnabled,
    appealRowTitle,
    songDetailsUrl,
    type SongAppealRow,
    type SongDetails,
  } from '$lib/audio-review';
  import { entityUrl, imageLookupUrl, userUrl } from '$lib/entity-url';
  import { fetchJson } from '$lib/fetch-json';
  import { dateTime, LINK_BUTTON, LINK_CLASS, shortAge, shortDate } from '$lib/format';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import { decisionReasonOptions, decisionReasonProblem } from '$lib/triage/decision-reasons';
  import type { Outcome } from '$lib/triage/queue';
  import SongSideCards from './SongSideCards.svelte';

  let {
    row,
    civitaiUrl,
    canAct,
    verdict,
    error,
    submit,
    actionHref,
  }: {
    row: SongAppealRow;
    civitaiUrl: string;
    canAct: boolean;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
  } = $props();

  const song = $derived(row.song);
  const isSong = $derived(row.kind === 'song');
  const enabled = $derived(appealDecisionsEnabled(row, canAct));
  // The song's side cards: the song appealed, or the song a cover belongs to. Client only.
  const details = $derived(
    browser && song && !row.withheld ? fetchJson<SongDetails>(songDetailsUrl(song.id)) : SSR_PENDING
  );

  const RULINGS = [
    { action: 'approveAppeal', verdict: 'Approved', label: 'Approve appeal' },
    { action: 'rejectAppeal', verdict: 'Rejected', label: 'Reject appeal' },
  ] as const;
  const reasonOptions = decisionReasonOptions(
    RULINGS.map((r) => ({ label: r.label, reasons: resolutionReasonsFor('appeal', r.verdict) }))
  );

  let reason = $state('');
  let note = $state('');
  let message = $state('');
  let problem = $state<string | null>(null);
  let reasonSelect = $state<HTMLElement | null>(null);
  let noteInput = $state<HTMLInputElement | null>(null);

  // One step: the decision button submits with the reason, note and message already in the bar,
  // unless the reason cannot be recorded for that decision; then nothing is sent and the bar says why.
  const decide: SubmitFunction = (input) => {
    const ruling = RULINGS.find((r) => input.action.search.includes(`/${r.action}`));
    const refusal = !ruling
      ? 'Pick a decision.'
      : decisionReasonProblem('appeal', ruling.verdict, ruling.label, reason, note);
    if (!ruling || refusal) {
      input.cancel();
      problem = refusal;
      reasonSelect?.focus();
      return;
    }
    problem = null;
    return submit(ruling.verdict === 'Approved' ? 'Appeal approved' : 'Appeal rejected')(input);
  };

  const subject = $derived(isSong ? 'song' : 'cover');
</script>

{#snippet chip(text: string, tone = 'bg-dark-5 text-dark-0')}
  <span class="rounded px-1.5 py-px text-[11px] font-medium {tone}">{text}</span>
{/snippet}

{#snippet fact(label: string, value: string | null | undefined)}
  <div class="grid grid-cols-[104px_1fr] gap-3 py-0.5">
    <span class="text-dark-2">{label}</span>
    <span class="min-w-0 wrap-anywhere text-white">{value || '—'}</span>
  </div>
{/snippet}

{#snippet buttons()}
  {#each RULINGS as ruling, i (ruling.action)}
    <TriageKeyButton
      key={i + 1}
      type="submit"
      tone={i === 0 ? 'blue' : 'red'}
      formaction={actionHref(ruling.action)}
      disabled={!enabled[i]}
    >
      {ruling.label}
    </TriageKeyButton>
  {/each}
{/snippet}

{#snippet fields()}
  <InlineReasonFields
    compact
    options={reasonOptions}
    bind:reason={
      () => reason,
      (next) => {
        reason = next;
        problem = null;
        if (reasonRequiresNote(next)) noteInput?.focus();
      }
    }
    bind:note
    bind:select={reasonSelect}
    bind:noteInput
  />
{/snippet}

{#snippet decision()}
  <form method="POST" action={actionHref('rejectAppeal')} use:enhance={decide} class="w-full">
    <input type="hidden" name="imageId" value={row.id} />
    <TriageDecisionBar
      compact
      {buttons}
      {fields}
      {problem}
      hint="J/K to move · 1 or 2 decide. Approving restores the {subject} only{isSong
        ? ''
        : ', not the song'}; a {isSong ? 'removed cover' : 'removed song'} is appealed separately."
    />
    <Input
      name="resolvedMessage"
      bind:value={message}
      maxlength={1000}
      aria-label="Message to the owner"
      placeholder="Message to the owner (optional)"
      class="mt-1.5 h-[30px] border-dark-4 bg-dark-7 text-[13px] placeholder:text-dark-2 dark:bg-dark-7"
    />
  </form>
{/snippet}

<TriageColumns {verdict} {error} decision={row.withheld ? undefined : decision}>
  {#snippet header()}
    <TriageDetailHeader title={appealRowTitle(row)} reference="#{row.id}">
      {#snippet chips()}
        {#if isSong}
          <SongBadge class="h-[17px] px-1.5 text-[11px]" />
        {:else}
          {@render chip('Cover')}
        {/if}
        {@render chip('Appeal', 'bg-amber-500/15 text-amber-300')}
        {@render chip('Removed')}
        {#if row.appeals > 1}{@render chip(`Repeat ×${row.appeals}`, 'bg-amber-500/15 text-amber-300')}{/if}
      {/snippet}
      {#snippet links()}
        {#if !row.withheld}
          {#if song}
            {@const songHref = entityUrl(civitaiUrl, 'image', song.id)}
            {#if songHref}
              <Button
                variant="outline"
                size="sm"
                class={LINK_BUTTON}
                href={songHref}
                target="_blank"
                rel="noreferrer"
              >
                <IconExternalLink aria-hidden="true" /> Open song
              </Button>
            {/if}
          {/if}
          {#if row.owner?.username}
            <Button
              variant="outline"
              size="sm"
              class={LINK_BUTTON}
              href={userUrl(civitaiUrl, row.owner.username)}
              target="_blank"
              rel="noreferrer"
            >
              <IconUser aria-hidden="true" /> Owner
            </Button>
            <Button
              variant="outline"
              size="sm"
              class={LINK_BUTTON}
              href={userUrl(civitaiUrl, row.owner.username, 'music')}
              target="_blank"
              rel="noreferrer"
            >
              <IconSearch aria-hidden="true" /> Owner's songs
            </Button>
          {/if}
        {/if}
      {/snippet}
    </TriageDetailHeader>
  {/snippet}

  {#snippet evidence()}
    <div class="space-y-3">
      {#if row.withheld}
        <div class="space-y-2 rounded-lg border border-dark-4 bg-dark-7 p-3.5 text-sm text-dark-0">
          <p class="m-0">
            This {subject} is withheld from you: its media, owner and appeal are not shown here.
          </p>
          <a href="/csam/text-holds?status=all&q={row.id}" class={LINK_CLASS}>Open in CSAM holds</a>
        </div>
      {:else if isSong}
        <p class="m-0 rounded-lg border border-dark-4 bg-dark-7 px-3.5 py-2 text-[13px] text-dark-0">
          This song is removed. It plays from storage for moderators only.
        </p>
        {#if row.url}
          <SongCard item={{ id: row.id, url: row.url }} variant="detail" />
        {/if}
      {:else}
        <p class="m-0 rounded-lg border border-dark-4 bg-dark-7 px-3.5 py-2 text-[13px] text-dark-0">
          This cover is removed: the song shows the placeholder. Approving puts the cover back on the
          song; the song itself is not changed.
        </p>
        {#if row.url}
          <div class="overflow-hidden rounded-lg border border-dark-4 bg-dark-7">
            <CdnOrRetractedMedia
              item={{ id: row.id, url: row.url, type: 'image' }}
              width={640}
              class="max-h-[420px] w-full object-contain"
            />
          </div>
        {/if}
        {#if song}
          <a href={imageLookupUrl(song.id)} class="text-sm {LINK_CLASS}">
            Cover of song {song.title || `#${song.id}`}
          </a>
        {/if}
      {/if}
      {#if !row.withheld && song}
        {#await details}
          <p class="m-0 text-sm text-dark-2">Loading the song's details…</p>
        {:then d}
          <TriageCard title="Song" dense>
            {@render fact('Genre', d.facts.genre)}
            {@render fact('Posted', d.facts.postedAt ? shortDate(d.facts.postedAt) : 'Not posted')}
            {@render fact('Remix', d.facts.allowRemix ? 'Allowed' : 'Not allowed')}
          </TriageCard>
        {:catch}
          <p class="m-0 text-sm text-dark-2">
            Couldn't load the song's facts, cover, checks, generation details and owner.
          </p>
        {/await}
      {/if}
    </div>
  {/snippet}

  {#snippet info()}
    <TriageCard title="Owner's appeal" dense accent="blue">
      {@render fact(
        'Filed',
        `${shortAge(row.waitingSince)} ago · ${row.appeals > 1 ? `appeal ${row.appeals}` : 'first appeal'}`
      )}
      {@render fact('Appeal of', isSong ? 'The song' : 'The cover')}
      {#if row.message}
        <p
          class="m-0 mt-1.5 wrap-anywhere whitespace-pre-wrap text-dark-0"
          title={dateTime(row.waitingSince)}
        >
          “{row.message}”
        </p>
      {/if}
    </TriageCard>

    {#if row.removal}
      <TriageCard title="Removal" dense accent="red">
        {@render fact(
          'Removed by',
          [row.removal.by, row.removal.at ? shortDate(row.removal.at) : null].filter(Boolean).join(' · ')
        )}
        {@render fact('Violation', row.removal.reason)}
        {@render fact('Public view', isSong ? 'Song hidden' : 'Placeholder on the song')}
      </TriageCard>
    {/if}

    {#if !row.withheld && song}
      {#await details}
        <p class="m-0 text-sm text-dark-2">Loading the cover, checks and owner…</p>
      {:then d}
        <SongSideCards
          details={d}
          {civitaiUrl}
          coverNote={isSong ? 'A removed cover has its own appeal in the list.' : undefined}
        />
      {:catch}
        <!-- Reported in the middle column. -->
      {/await}
    {/if}
  {/snippet}
</TriageColumns>
