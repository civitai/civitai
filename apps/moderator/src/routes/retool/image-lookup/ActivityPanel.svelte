<script lang="ts">
  import { untrack } from 'svelte';
  import { reportDetail, reportStatusVariant } from '$lib/reports';
  import { userLookupUrl } from '$lib/entity-url';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import type { PageData } from './$types';

  type Result = NonNullable<PageData['result']>;

  let {
    imageId,
    reports,
    modActivity,
    reactions,
  }: {
    imageId: number;
    reports: Result['reports'];
    modActivity: Result['modActivity'];
    reactions: Result['reactions'];
  } = $props();

  type ReactionRow = Result['reactions']['rows'][number];

  const SHOWN = 8;
  const PAGE = 1000;
  /** 1,000 x 20 = 20,000 rows. A bound, so a server that keeps answering cannot spin this forever. */
  const MAX_PAGES = 20;

  let expandedReactions = $state(false);
  // Rows pulled since load, kept separate from the page's own. They must not survive a move to another
  // image, and what guarantees that is the `{#key result.image.id}` around every panel in
  // `+page.svelte` — a `?q=` navigation does not remount on its own.
  let fetched = $state<ReactionRow[]>([]);
  let loading = $state(false);
  let loadFailed = $state(false);
  // `createdAt` is a Date off the page load (SvelteKit's serialiser preserves them) and a string off
  // the endpoint's JSON, so it is normalised at the one place it is sent rather than typed as one.
  let cursor = $state<{ createdAt: string | Date; id: number } | null>(untrack(() => reactions.nextCursor));
  /** The count as of the LAST page fetched, not as of page load — reactions are deleted outright on
   *  un-react, so the set genuinely shrinks while a moderator reads it. */
  let liveTotal = $state(untrack(() => reactions.total));

  const allReactions = $derived([...reactions.rows, ...fetched]);
  const visibleReactions = $derived(
    expandedReactions ? allReactions : allReactions.slice(0, SHOWN)
  );

  /**
   * 🔴 The endpoint answers JSON, so its timestamps arrive as STRINGS while the page-load rows are
   * `Date`s. `dateTime` takes either, but the changed-reaction check below calls `.getTime()` — which
   * throws on a string, and only on the rows that came from here. Normalised on the way in so the
   * list holds one type.
   */
  const normalise = (r: ReactionRow): ReactionRow => ({
    ...r,
    createdAt: new Date(r.createdAt),
    updatedAt: r.updatedAt ? new Date(r.updatedAt) : null,
    bannedAt: r.bannedAt ? new Date(r.bannedAt) : null,
  });

  async function loadEveryReaction() {
    loading = true;
    loadFailed = false;
    try {
      // Bounded, and it also stops when the server says there is no next page — a loop that can only
      // end when a counter matches a server-supplied total will spin if the two ever disagree.
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({ limit: String(PAGE) });
        if (cursor) {
          params.set('beforeCreatedAt', new Date(cursor.createdAt).toISOString());
          params.set('beforeId', String(cursor.id));
        }
        const res = await fetch(`/api/image-reactions/${imageId}?${params}`);
        if (!res.ok) throw new Error(String(res.status));
        const body: {
          rows: ReactionRow[];
          total: number;
          nextCursor: { createdAt: string; id: number } | null;
        } = await res.json();

        // 🔴 The endpoint re-counts on every page, and this takes that number. Holding the count from
        // page load means telling the operator "300 of 312" while they hold every row that still
        // exists — twelve having been withdrawn while they read — and leaving a "Load all" button on
        // screen that can do nothing.
        liveTotal = body.total;

        // De-duplicated by key even though the cursor should make it impossible: a repeated row is not
        // a cosmetic problem here, `{#each … (r.key)}` THROWS on a duplicate key in production, so the
        // panel would die mid-load rather than render one row twice.
        const seen = new Set(allReactions.map((r) => r.key));
        const added = body.rows.filter((r) => !seen.has(r.key)).map(normalise);
        if (added.length) fetched = [...fetched, ...added];

        cursor = body.nextCursor;
        if (!cursor) break;
      }
    } catch {
      loadFailed = true;
    } finally {
      loading = false;
      // Expanded even on a partial failure: the rows that DID arrive were fetched because someone asked
      // to see them, and leaving the list collapsed at 8 while the status line reports thousands loaded
      // describes a screen the operator is not looking at.
      if (allReactions.length > SHOWN) expandedReactions = true;
    }
  }
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-3">
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-3 text-sm font-semibold text-white">Reports ({reports.length})</h3>
    {#if reports.length === 0}
      <p class="text-sm text-dark-2">Never reported.</p>
    {:else}
      <ul class="space-y-1.5 text-sm">
        {#each reports as r (r.id)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <Badge variant={reportStatusVariant(r.status)}>{r.status}</Badge>
            <span class="text-dark-0">{r.reason}</span>
            {#if r.reportedBy}
              <a href={userLookupUrl(r.reportedById)} class="text-xs {LINK_CLASS}">
                {r.reportedBy}
              </a>
            {/if}
            <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
            <!-- One report and thirty reports are the same row without this. -->
            {#if r.alsoReportedBy?.length}
              <span class="text-xs text-amber-300">
                +{r.alsoReportedBy.length} also reported
              </span>
            {/if}
            {#if r.previouslyReviewedCount}
              <span class="text-xs text-dark-2">reviewed {r.previouslyReviewedCount}× before</span>
            {/if}
            {#if r.statusSetBy}
              <span class="text-xs text-dark-2">
                {r.status.toLowerCase()} by {r.statusSetBy}{r.statusSetAt
                  ? ` · ${dateTime(r.statusSetAt)}`
                  : ''}
              </span>
            {/if}
            {#if reportDetail(r.details, 'comment')}
              <!-- The reporter's own words: the only part of a report that says what happened. -->
              <p class="w-full wrap-break-word text-xs text-dark-1">
                {reportDetail(r.details, 'comment')}
              </p>
            {/if}
            {#if r.internalNotes}
              <p class="w-full wrap-break-word text-xs text-dark-2">
                Internal: {r.internalNotes}
              </p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">
      Moderator activity ({modActivity.rows.length}{modActivity.truncated ? '+' : ''})
    </h3>
    <p class="mb-3 text-xs text-dark-2">Actions taken on this image, and who took them.</p>
    {#if modActivity.rows.length === 0}
      <p class="text-sm text-dark-2">No recorded moderator activity.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each modActivity.rows as a (a.id)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <Badge variant="secondary">{a.activity}</Badge>
            <span class="text-xs text-dark-2">
              {a.moderatorUsername ?? (a.moderatorId ? `#${a.moderatorId}` : 'system')} · {dateTime(
                a.createdAt
              )}
            </span>
          </li>
        {/each}
      </ul>
      {#if modActivity.truncated}
        <p class="mt-2 text-xs text-amber-300">
          Capped — older actions than these exist and are not shown.
        </p>
      {/if}
    {/if}
  </div>

  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <!-- The COUNTED total, never the number of rows in hand. "100+" on an image with 312 was the
         complaint this page's ticket opened with. -->
    <h3 class="mb-1 text-sm font-semibold text-white">Reactions ({num(liveTotal)})</h3>
    <p class="mb-3 text-xs text-dark-2">Most recent first.</p>
    {#if allReactions.length === 0 && liveTotal === 0}
      <p class="text-sm text-dark-2">No reactions.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each visibleReactions as r (r.key)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <Badge variant="secondary">{r.reaction}</Badge>
            <a href={userLookupUrl(r.userId)} class={LINK_CLASS}>
              {r.username ?? `#${r.userId}`}
            </a>
            {#if r.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
            <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
            <!-- Only when it differs: a reaction that was CHANGED is a different signal from one given
                 once, and printing an identical second timestamp on every other row buries it. -->
            {#if r.updatedAt && r.updatedAt.getTime() !== r.createdAt.getTime()}
              <span class="text-xs text-dark-2">· changed {dateTime(r.updatedAt)}</span>
            {/if}
          </li>
        {/each}
      </ul>
      <div class="flex flex-wrap items-center gap-x-4">
        <!-- 🔴 `capped` is not decoration: without it the label reads "Show all 100" on an image with
             7,548 — the same cap-presented-as-a-total that this page's ticket was opened about, one
             control left of the header that was fixed for it. -->
        <ShowMoreButton
          total={allReactions.length}
          shown={SHOWN}
          expanded={expandedReactions}
          capped={allReactions.length < liveTotal}
          onToggle={() => (expandedReactions = !expandedReactions)}
        />
        {#if allReactions.length < liveTotal}
          <!-- `LINK_CLASS` carries no disabled treatment, so a pull in flight would otherwise stay
               full-strength blue and underline on hover, reading as clickable while it is inert. -->
          <button
            type="button"
            class="mt-3 text-sm {LINK_CLASS} disabled:no-underline disabled:opacity-60"
            onclick={loadEveryReaction}
            disabled={loading}
            aria-busy={loading}
          >
            {loading
              ? `Loading… ${num(allReactions.length)} of ${num(liveTotal)}`
              : `Load all ${num(liveTotal)}`}
          </button>
        {/if}
      </div>
      {#if loadFailed}
        <p class="mt-2 text-xs text-amber-300">
          Could not load the rest — {num(allReactions.length)} of {num(liveTotal)} loaded.
        </p>
      {:else if allReactions.length < liveTotal}
        <p class="mt-2 text-xs text-dark-2">
          The most recent {num(allReactions.length)} of {num(liveTotal)} loaded.
        </p>
      {/if}
    {/if}
  </div>
</section>
