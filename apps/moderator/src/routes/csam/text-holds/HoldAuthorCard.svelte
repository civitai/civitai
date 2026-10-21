<script lang="ts">
  import { page } from '$app/state';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import FactRow from '$lib/components/minor-flags/FactRow.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import UserCard from '$lib/components/user-card/UserCard.svelte';
  import { LINK_CLASS, dateTime, plural, shortAge } from '$lib/format';
  import { urlWith } from '$lib/url';
  import type { HoldAuthor } from './hold-author';
  import { decisionLabel, entityLabel } from './hold-entity';

  let {
    author,
    failed,
    holdId,
    onretry,
  }: {
    /** Null while it loads. */
    author: HoldAuthor | null;
    failed: boolean;
    holdId: number;
    onretry: () => void;
  } = $props();

  const SHOWN = 6;

  // Searching the author's id lists every hold they have had; the link opens the one asked for.
  const holdHref = (id: number) =>
    urlWith(page.url, { hold: id, status: 'all', entityType: null, q: author?.userId, page: null });

  const counts = $derived(author?.counts?.filter((c) => c.count > 0) ?? []);
  const reported = $derived(author?.reportedContent?.filter((c) => c.count > 0) ?? []);
  const others = $derived(author?.holds.others.slice(0, SHOWN) ?? []);
  const pendingTotal = $derived(
    author?.holds.others.filter((hold) => hold.status === 'Pending').length ?? 0
  );
</script>

<TriageCard dense title="Author">
  {#if failed}
    <p class="m-0 text-sm text-dark-0" role="alert">
      Could not load the author.
      <button type="button" class={LINK_CLASS} onclick={onretry}>Try again</button>
    </p>
  {:else if !author}
    <p class="m-0 text-dark-2" role="status">Loading the author…</p>
  {:else}
    <div class="space-y-3">
      {#if author.card}
        <UserCard card={author.card} compact lookupLink />
        <dl class="m-0 space-y-1.5">
          <FactRow label="Joined">
            {author.card.identity.createdAt
              ? `${dateTime(author.card.identity.createdAt)} (${shortAge(author.card.identity.createdAt)} ago)`
              : '—'}
          </FactRow>
          <FactRow label="Content">
            {#if counts.length}
              <span class="flex flex-wrap gap-1">
                {#each counts as c (c.label)}<MetaChip>{c.count.toLocaleString()} {c.label.toLowerCase()}</MetaChip>{/each}
              </span>
            {:else if author.counts}
              none
            {:else}
              —
            {/if}
          </FactRow>
          <FactRow label="Reported">
            {#if reported.length}
              <span class="flex flex-wrap gap-1">
                {#each reported as c (c.label)}<MetaChip tone="amber">{c.count.toLocaleString()} {c.label.toLowerCase()}</MetaChip>{/each}
              </span>
            {:else if author.reportedContent}
              nothing reported
            {:else}
              —
            {/if}
          </FactRow>
        </dl>
      {/if}

      <div>
        <p class="m-0 mb-1.5 text-dark-0">
          {#if author.holds.total === 0}
            No other holds for this author.
          {:else}
            {plural(author.holds.total, 'other hold')} for this author{pendingTotal
              ? `, ${pendingTotal} pending`
              : ''}.
            {#if author.holds.total > others.length}
              <a
                href={urlWith(page.url, { status: 'all', entityType: null, q: author.userId, hold: holdId, page: null })}
                class={LINK_CLASS}>See all</a
              >
            {/if}
          {/if}
        </p>
        {#if others.length}
          <ul class="m-0 list-none space-y-1 p-0">
            {#each others as other (other.id)}
              <li class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dark-0">
                <a href={holdHref(other.id)} class={LINK_CLASS}>
                  {entityLabel(other.entityType)} #{other.entityId}
                </a>
                {#if other.status === 'Pending'}
                  <MetaChip tone="amber">pending</MetaChip>
                {:else}
                  <MetaChip tone={other.status === 'Dismissed' ? 'neutral' : 'red'}>
                    {decisionLabel(other)}
                  </MetaChip>
                {/if}
                <span class="text-dark-2">
                  {other.decidedAt ? `decided ${shortAge(other.decidedAt)} ago` : `held ${shortAge(other.createdAt)} ago`}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  {/if}
</TriageCard>
