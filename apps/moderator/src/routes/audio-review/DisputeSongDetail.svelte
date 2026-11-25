<script lang="ts">
  import { browser } from '$app/environment';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { IconExternalLink, IconSearch, IconUser } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import SongBadge from '$lib/components/SongBadge.svelte';
  import SongCard from '$lib/components/SongCard.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageColumns from '$lib/components/triage/TriageColumns.svelte';
  import TriageDetailHeader from '$lib/components/triage/TriageDetailHeader.svelte';
  import {
    disputeRowTitle,
    songDetailsUrl,
    songRatingLabel,
    SONG_RATING_LEVELS,
    type SongDetails,
    type SongDisputeRow,
  } from '$lib/audio-review';
  import { entityUrl, userUrl } from '$lib/entity-url';
  import { fetchJson } from '$lib/fetch-json';
  import { dateTime, LINK_BUTTON, LINK_CLASS, ordinal, shortAge, shortDate } from '$lib/format';
  import { SONG_ENTITY_TYPE } from '$lib/rating-review';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import type { Outcome } from '$lib/triage/queue';
  import RatingDecisionForm from '../ratings/RatingDecisionForm.svelte';
  import SongSideCards from './SongSideCards.svelte';

  let {
    row,
    civitaiUrl,
    canAct,
    verdict,
    error,
    submit,
    actionHref,
    chosen = $bindable(),
  }: {
    row: SongDisputeRow;
    civitaiUrl: string;
    canAct: boolean;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    chosen: number | null;
  } = $props();

  // The song's side cards. Client only, and never for a withheld song or one that is gone.
  const details = $derived(
    browser && !row.withheld && row.state !== 'gone'
      ? fetchJson<SongDetails>(songDetailsUrl(row.songId))
      : SSR_PENDING
  );

  // The dispute as /ratings' decision form reads it: a song that is gone is a deleted entity, whose
  // ruling closes the dispute and applies nothing.
  const dispute = $derived(
    row.currentLevel != null && row.suggestedLevel != null
      ? {
          id: row.id,
          entityType: SONG_ENTITY_TYPE as 'Song',
          currentLevel: row.currentLevel,
          suggestedLevel: row.suggestedLevel,
          levelOptions: [...SONG_RATING_LEVELS],
          entity: row.state === 'gone' ? null : row,
        }
      : null
  );
  const decides = $derived(canAct && !row.withheld && row.state !== 'unreviewed' && !!dispute);
  const songHref = $derived(entityUrl(civitaiUrl, 'image', row.songId));
  const level = (value: number | null) => (value == null ? '—' : songRatingLabel(value));
  const EARLIER_VERDICT: Record<string, string> = { Actioned: 'approved', Unactioned: 'rejected' };
  const earlierText = (e: NonNullable<SongDisputeRow['earlier']>) =>
    `${e.resolvedAt ? `Ruled ${shortDate(e.resolvedAt)}` : 'Ruled'}: ${
      EARLIER_VERDICT[e.status] ?? e.status.toLowerCase()
    }${e.appliedLevel != null ? `, applied ${level(e.appliedLevel)}` : ''}`;
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

{#snippet levelCard(heading: string, value: string, sub: string, accent: 'blue' | undefined = undefined)}
  <TriageCard title={heading} dense {accent}>
    <p class="m-0 text-xl font-semibold text-white">{value}</p>
    <p class="m-0 mt-0.5 text-xs text-dark-2">{sub}</p>
  </TriageCard>
{/snippet}

{#snippet decision()}
  {#if dispute}
    <RatingDecisionForm
      row={dispute}
      {submit}
      {actionHref}
      action="resolveDispute"
      hint="Applying the owner's rating approves the dispute; any other rating rejects it. The level goes to the song and the owner is told; they see the note."
      bind:chosen
    />
  {/if}
{/snippet}

<TriageColumns {verdict} {error} decision={decides ? decision : undefined}>
  {#snippet header()}
    <TriageDetailHeader title={disputeRowTitle(row)} reference="#{row.songId}">
      {#snippet chips()}
        <SongBadge class="h-[17px] px-1.5 text-[11px]" />
        {@render chip('Rating dispute', 'bg-blue-500/15 text-blue-300')}
        {@render chip('Pending', 'bg-amber-500/15 text-amber-300')}
        {#if row.disputes > 1}{@render chip(`Repeat ×${row.disputes}`, 'bg-amber-500/15 text-amber-300')}{/if}
      {/snippet}
      {#snippet links()}
        {#if !row.withheld}
          {#if songHref && row.state !== 'gone'}
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
    <div class="flex flex-col gap-4">
      {#if row.withheld}
        <div class="space-y-2 rounded-lg border border-dark-4 bg-dark-7 p-3.5 text-sm text-dark-0">
          <p class="m-0">
            This song is withheld from you: its media, owner and dispute are not shown here.
          </p>
          <a href="/images/csam" class={LINK_CLASS}>Open the CSAM image queue</a>
        </div>
      {:else}
        {#if row.state === 'unreviewed'}
          <p
            class="m-0 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3.5 py-2 text-[13px] text-amber-200"
          >
            This song's own scans have not reviewed it yet; they are running or will be retried. Rule
            on its dispute once they have.
          </p>
        {:else if row.state === 'gone'}
          <p
            class="m-0 rounded-lg border border-dark-4 bg-dark-7 px-3.5 py-2 text-[13px] text-dark-0"
          >
            This song was deleted, removed or will never be reviewed by its scans, so it can't be
            rated. Any decision closes the dispute and applies nothing.
          </p>
        {/if}
        {#if row.url && row.state !== 'gone'}
          <SongCard item={{ id: row.songId, url: row.url }} variant="detail" />
        {/if}
        {#if row.state !== 'gone'}
          {#await details}
            <p class="m-0 text-sm text-dark-2">Loading the song's details…</p>
          {:then d}
            <TriageCard title="Song" dense>
              {@render fact('Genre', d.facts.genre)}
              <div class="grid grid-cols-[104px_1fr] gap-3 py-0.5">
                <span class="text-dark-2">Posted</span>
                <span class="text-white">
                  {d.facts.postedAt ? shortDate(d.facts.postedAt) : 'Not posted'}
                  {#if d.facts.postId}
                    · <a
                      href={entityUrl(civitaiUrl, 'post', d.facts.postId)}
                      target="_blank"
                      rel="noreferrer"
                      class={LINK_CLASS}>Open post</a
                    >
                  {/if}
                </span>
              </div>
              {@render fact('Rating', level(row.songLevel))}
              {@render fact('Remix', d.facts.allowRemix ? 'Allowed' : 'Not allowed')}
            </TriageCard>
          {:catch}
            <p class="m-0 text-sm text-dark-2">
              Couldn't load the song's facts, cover, checks, generation details and owner.
            </p>
          {/await}
        {/if}
      {/if}
    </div>
  {/snippet}

  {#snippet info()}
    {#if !row.withheld}
      <div class="grid grid-cols-2 gap-2">
        {@render levelCard('Current', level(row.currentLevel), 'when the owner disputed it')}
        {@render levelCard('Owner asks', level(row.suggestedLevel), 'approving applies this', 'blue')}
      </div>

      {#if row.message}
        <TriageCard title="Owner comment" dense>
          <p class="m-0 wrap-anywhere whitespace-pre-wrap text-dark-0" title={dateTime(row.waitingSince)}>
            {row.message}
          </p>
        </TriageCard>
      {:else}
        <p class="m-0 text-sm text-dark-2">No comment from owner</p>
      {/if}
    {/if}

    <TriageCard title="This dispute" dense accent="blue">
      {@render fact(
        'Filed',
        `${shortAge(row.waitingSince)} ago · ${row.disputes > 1 ? `${ordinal(row.disputes)} dispute` : 'first dispute'}`
      )}
      {#if row.earlier}
        {@render fact('Earlier dispute', earlierText(row.earlier))}
      {/if}
    </TriageCard>

    {#if !row.withheld && row.state !== 'gone'}
      {#await details}
        <p class="m-0 text-sm text-dark-2">Loading the cover, checks and owner…</p>
      {:then d}
        <SongSideCards
          details={d}
          {civitaiUrl}
          coverNote="The cover has its own rating. A song dispute does not change it."
        />
      {:catch}
        <!-- Reported in the middle column. -->
      {/await}
    {/if}
  {/snippet}
</TriageColumns>
