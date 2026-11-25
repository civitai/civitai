<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { IconExternalLink, IconScale, IconUser } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import SongBadge from '$lib/components/SongBadge.svelte';
  import SongCard from '$lib/components/SongCard.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageColumns from '$lib/components/triage/TriageColumns.svelte';
  import TriageDetailHeader from '$lib/components/triage/TriageDetailHeader.svelte';
  import {
    disputeRowTitle,
    disputeRulingText,
    ownerFilterHref,
    songActivityText,
    songRatingLabel,
    SONG_RATING_LEVELS,
    SONG_SCAN_LEVEL,
    type SongDetails,
    type SongDisputeRow,
  } from '$lib/audio-review';
  import { entityUrl, userUrl } from '$lib/entity-url';
  import { dateTime, LINK_BUTTON, LINK_CLASS, ordinal, shortAge, shortDate } from '$lib/format';
  import { SONG_ENTITY_TYPE } from '$lib/rating-review';
  import { songDetails } from '$lib/music/song-details.svelte';
  import type { Outcome } from '$lib/triage/queue';
  import RatingDecisionForm from '../ratings/RatingDecisionForm.svelte';
  import SongSideCards from './SongSideCards.svelte';
  import SongWithheldNotice from './SongWithheldNotice.svelte';

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

  const details = songDetails(
    () => (row.withheld || row.state === 'gone' ? null : row.songId),
    'disputes'
  );

  // Judged on the song's live level, which may differ from what the owner saw. A gone song is a
  // deleted entity: its ruling applies nothing.
  const dispute = $derived(
    row.currentLevel != null && row.suggestedLevel != null
      ? {
          id: row.id,
          entityType: SONG_ENTITY_TYPE as 'Song',
          currentLevel: row.songLevel ?? row.currentLevel,
          suggestedLevel: row.suggestedLevel,
          levelOptions: [...SONG_RATING_LEVELS],
          entity: row.state === 'gone' ? null : row,
        }
      : null
  );
  const pending = $derived(row.status === 'Pending');
  const decides = $derived(
    canAct && pending && !row.withheld && row.state !== 'unreviewed' && !!dispute
  );
  const songHref = $derived(entityUrl(civitaiUrl, 'image', row.songId));
  const level = (value: number | null) => (value == null ? '—' : songRatingLabel(value));
  const rulingText = (r: NonNullable<SongDisputeRow['earlier']>) =>
    `${r.resolvedAt ? `Ruled ${shortDate(r.resolvedAt)}` : 'Ruled'}: ${disputeRulingText(r)}`;
  const nth = (n: number) => (n > 1 ? `${ordinal(n)} dispute` : 'first dispute');
  const STATUS_CHIP: Record<string, { label: string; class: string }> = {
    Pending: { label: 'Pending', class: 'bg-amber-500/15 text-amber-300' },
    Actioned: { label: 'Approved', class: 'bg-green-500/15 text-green-300' },
    Unactioned: { label: 'Rejected', class: 'bg-dark-5 text-dark-0' },
  };
  const statusChip = $derived(
    STATUS_CHIP[row.status] ?? { label: row.status, class: 'bg-dark-5 text-dark-0' }
  );
  const setBy = (r: NonNullable<SongDetails['rating']>) =>
    r.source === 'scan'
      ? 'Its scans'
      : r.source === 'moderator'
        ? `Moderator: ${r.by ?? 'unknown'}`
        : 'Not recorded';
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
        {@render chip(statusChip.label, statusChip.class)}
        {#if (row.disputes ?? 0) > 1}{@render chip(`Repeat ×${row.disputes}`, 'bg-amber-500/15 text-amber-300')}{/if}
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
          {/if}
          {#if row.owner}
            <Button
              variant="outline"
              size="sm"
              class={LINK_BUTTON}
              href={ownerFilterHref('disputes', row.owner.id, '&status=all')}
            >
              <IconScale aria-hidden="true" /> Owner's disputes
            </Button>
          {/if}
        {/if}
      {/snippet}
    </TriageDetailHeader>
    {#if row.owner && row.disputes != null}
      <p class="m-0 mt-1 text-[13px] text-dark-2" title={dateTime(row.waitingSince)}>
        by {row.owner.username ?? `User #${row.owner.id}`} · disputed {shortAge(row.waitingSince)} ago
        · {nth(row.disputes)}
      </p>
    {/if}
  {/snippet}

  {#snippet evidence()}
    <div class="flex flex-col gap-4">
      {#if row.withheld}
        <SongWithheldNotice subject="song" hidden="its media, owner and dispute" />
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
          {#await details.current}
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
              {#if d.activity}{@render fact('Activity', songActivityText(d.activity))}{/if}
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
      <div class="grid grid-cols-3 gap-2">
        {@render levelCard(
          'Current',
          level(row.songLevel ?? row.currentLevel),
          row.songLevel != null && row.songLevel !== row.currentLevel
            ? `${level(row.currentLevel)} when disputed`
            : 'current rating'
        )}
        {@render levelCard(
          'Owner asks',
          level(row.suggestedLevel),
          pending ? 'approving applies this' : 'what the owner asked for',
          'blue'
        )}
        {@render levelCard(
          'Scan default',
          row.state === 'reviewed' ? level(SONG_SCAN_LEVEL) : '—',
          row.state === 'reviewed' ? 'what the scan gave it' : 'no scan verdict'
        )}
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
        `${shortAge(row.waitingSince)} ago${row.disputes == null ? '' : ` · ${nth(row.disputes)}`}`
      )}
      {#if row.ruling}
        {@render fact(
          'Ruling',
          `${rulingText(row.ruling)}${row.ruling.by ? ` by ${row.ruling.by}` : ''}`
        )}
        {#if row.ruling.comment}{@render fact('Moderator note', row.ruling.comment)}{/if}
      {/if}
      {#if row.earlier}
        {@render fact('Earlier dispute', rulingText(row.earlier))}
      {/if}
    </TriageCard>

    {#if !row.withheld && row.state !== 'gone'}
      {#await details.current}
        <p class="m-0 text-sm text-dark-2">Loading the cover, checks and owner…</p>
      {:then d}
        {#if d.rating}
          <TriageCard title="Current rating" dense>
            {@render fact('Set by', setBy(d.rating))}
            {@render fact('Set on', d.rating.at ? shortDate(d.rating.at) : '—')}
            {@render fact('Before', d.rating.before != null ? level(d.rating.before) : 'Not recorded')}
          </TriageCard>
        {/if}
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
