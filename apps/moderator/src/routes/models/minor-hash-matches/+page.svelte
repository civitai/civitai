<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Rows are shaped per tab; the fields read below exist only on the tab that supplies them.
  type Row = PageData['items'][number] & Record<string, unknown>;
  const rows = $derived(data.items as Row[]);
  const n = (v: unknown) => (typeof v === 'number' ? v : null);
  const s = (v: unknown) => (typeof v === 'string' ? v : null);

  const tabHref = (tab: string) => {
    const url = new URL(page.url);
    url.searchParams.set('tab', tab);
    // Expanded rows and the limit both describe the tab you are leaving.
    url.searchParams.delete('limit');
    return url.pathname + url.search;
  };

  // modelId → verdict. Optimistic: the row dims and states the outcome. Cleared whenever the queue
  // itself changes, so a stale mark can never describe a different row.
  const acted = new SvelteMap<number, string>();
  const expanded = new SvelteSet<number>();
  $effect(() => {
    data.items;
    acted.clear();
    expanded.clear();
  });

  // A failed action must UNDO its optimistic mark. Leaving it makes the moderator's own record wrong,
  // and the row they then skip is the one that failed.
  const submit =
    (modelId: number, verdict: string): SubmitFunction =>
    () => {
      acted.set(modelId, verdict);
      return async ({ result, update }) => {
        // applyAction is what puts a `fail()` payload into `form`. Without it the error banner never
        // renders and a REFUSED verdict looks exactly like an applied one — which on this page means a
        // moderator believing they signed off on a minor flag that never happened.
        if (result.type !== 'success') {
          acted.delete(modelId);
          await applyAction(result);
          return;
        }
        await update({ invalidateAll: true });
      };
    };

  type Detail = {
    match: {
      minorModelId: number;
      minorModelName: string | null;
      minorModelVersionId: number | null;
      hash: string;
      /** The version of THIS model that carried the matched hash. Only the auto/appeals tabs get it
       *  from here — the Pending row already knows its own. */
      modelVersionId: number | null;
    } | null;
    detail: {
      modelCoverUrl: string | null;
      modelCoverType: string | null;
      modelCreatedAt: string | null;
      uploaderModelCount: number;
      uploaderJoinedAt: string | null;
      minorModelCoverUrl: string | null;
      minorModelCoverType: string | null;
      minorModelStatus: string | null;
      minorModelDeletedAt: string | null;
      minorUsername: string | null;
      minorFlaggedAt: string | null;
      minorFlaggedByUsername: string | null;
    } | null;
  };

  // Fetched on expand and cached per row. The promise is stored, not the resolved value, so the
  // template can await it — and a second expand of the same row does not refetch.
  // Aliased so the generic does not end in `>>`, which the script parser reads as a shift operator
  // and rejects — svelte-check accepts it, so the only symptom is a 500 from the dev server.
  type DetailRequest = Promise<Detail>;
  const details = new SvelteMap<number, DetailRequest>();
  function toggle(row: Row) {
    const id = Number(row.modelId);
    if (expanded.has(id)) return expanded.delete(id);
    expanded.add(id);
    if (details.has(id)) return;
    const seed = n(row.minorModelId);
    const q = seed ? `?minorModelId=${seed}` : '';
    details.set(
      id,
      fetch(`/api/minor-hash-detail/${id}${q}`).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Detail>;
      })
    );
  }

  // Version-specific, and `view=basic`, matching the href the main app builds. Landing on the model
  // with no version leaves a moderator guessing which of several files carried the matched hash.
  //
  // `versionId: number | null` rather than an OPTIONAL parameter: `versionId?:` in an arrow function
  // makes the Svelte script parser read the `?` as a ternary and fail the whole route with
  // "Parse failure: Expression expected" at a column that does not exist in the file. svelte-check
  // and esbuild both accept it, so nothing catches this except loading the page.
  const modelHref = (modelId: number, versionId: number | null) => {
    const base = `${data.civitaiUrl}/models/${modelId}?view=basic`;
    return versionId ? `${base}&modelVersionId=${versionId}` : base;
  };

  // Cached server-side and fetched here: the Pending count alone is ~10s, which is not a price to pay
  // on every page render to label three tabs.
  let counts = $state<{ pending: number; auto: number; appeals: number } | null>(null);
  $effect(() => {
    fetch('/api/minor-queue-counts')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (counts = d))
      .catch(() => (counts = null));
  });

  const pageHref = (n: number) => {
    const url = new URL(page.url);
    url.searchParams.set('page', String(n));
    return url.pathname + url.search;
  };
  const firstShown = $derived(data.offset + 1);
  const lastShown = $derived(data.offset + rows.length);
</script>

<header class="page-header">
  <h1>Minor Hash Matches</h1>
  <p>
    Models sharing a file hash with something a moderator flagged as depicting a minor, what the
    scanner flagged on its own, and the owners contesting it.
  </p>
</header>

<nav class="mb-4 flex gap-1 border-b border-dark-4">
  {#each data.tabs as t (t.value)}
    <a
      href={tabHref(t.value)}
      class={cn(
        'flex items-center gap-2 rounded-t-md px-4 py-2 text-sm',
        data.tab === t.value
          ? 'border-b-2 border-blue-500 text-white'
          : 'text-dark-2 hover:text-dark-0'
      )}
    >
      {t.label}
      <!-- Absent until loaded rather than a placeholder zero: "Appeals 0" is a claim, and on these
           queues it is the one a moderator would act on by not looking. -->
      {#if counts}
        <Badge variant="secondary">{num(counts[t.value])}</Badge>
      {/if}
    </a>
  {/each}
</nav>

{#if form && 'error' in form && form.error}
  <div class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300" role="alert">
    {form.error}
  </div>
{/if}

{#if rows.length === 0}
  <p class="text-sm text-dark-2">
    {data.tab === 'pending'
      ? 'No unreviewed hash matches.'
      : data.tab === 'auto'
        ? 'Nothing flagged automatically inside the review window.'
        : 'No open appeals against a minor flag.'}
  </p>
{:else}
  <ul class="space-y-2">
    {#each rows as row (row.modelId)}
      {@const modelId = Number(row.modelId)}
      {@const verdict = acted.get(modelId)}
      <li
        class={cn(
          'rounded-lg border border-dark-4 bg-dark-6 p-4 transition-opacity',
          verdict && 'opacity-50'
        )}
      >
        <div class="flex flex-wrap items-baseline gap-x-2">
          <a
            href={modelHref(modelId, n(row.modelVersionId))}
            target="_blank"
            rel="noreferrer"
            class="font-medium {LINK_CLASS}"
          >
            {s(row.modelName) ?? `#${modelId}`}
          </a>
          <code class="text-xs text-dark-2">#{modelId}</code>
          <Badge variant="secondary">{s(row.status) ?? 'unknown'}</Badge>
          {#if row.minor === false}
            <!-- Reverting from the Auto-flagged tab leaves the appeal open; the row has to say the
                 flag is already gone or a moderator upholds against nothing. -->
            <Badge variant="outline">no longer flagged</Badge>
          {/if}
          {#if s(row.flagSource)}
            <Badge variant="outline">
              {s(row.flagSource)}{s(row.flagConfirmedFrom) ? ` (was ${s(row.flagConfirmedFrom)})` : ''}
            </Badge>
          {/if}
          {#if row.username}
            <a href={userLookupUrl(Number(row.userId))} class="text-xs {LINK_CLASS}">
              {s(row.username)}
            </a>
          {/if}
          {#if s(row.flaggedAt)}
            <span class="text-xs text-dark-2">flagged {dateTime(s(row.flaggedAt))}</span>
          {/if}
          {#if s(row.createdAt)}
            <span class="text-xs text-dark-2">uploaded {dateTime(s(row.createdAt))}</span>
          {/if}
        </div>

        {#if s(row.appealMessage)}
          <p class="mt-2 rounded-md bg-dark-7 p-2 text-sm text-dark-0">{s(row.appealMessage)}</p>
          <p class="mt-1 text-xs text-dark-2">appealed {dateTime(s(row.appealCreatedAt))}</p>
        {/if}

        {#if s(row.hash)}
          <p class="mt-2 text-xs break-all text-dark-2">
            Matches
            {#if n(row.minorModelId)}
              <a
                href={modelHref(Number(row.minorModelId), n(row.minorModelVersionId))}
                target="_blank"
                rel="noreferrer"
                class={LINK_CLASS}
              >
                {s(row.minorModelName) ?? `#${n(row.minorModelId)}`}
              </a>
            {/if}
            on <code>{s(row.hash)}</code>
          </p>
        {/if}

        {#if row.prevNsfw != null || n(row.prevGalleryLevel) != null}
          <p class="mt-1 text-xs text-dark-2">
            Before the flag: NSFW {row.prevNsfw ? 'on' : 'off'}{n(row.prevGalleryLevel) != null
              ? `, gallery level ${n(row.prevGalleryLevel)}`
              : ''}
          </p>
        {/if}

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" onclick={() => toggle(row)}>
            {expanded.has(modelId) ? 'Hide detail' : 'Detail'}
          </Button>

          {#if verdict}
            <span class="text-sm text-dark-2">{verdict}</span>
          {:else if data.tab === 'pending'}
            <form method="POST" action="?/setMinor" use:enhance={submit(modelId, 'Flagged as minor')}>
              <input type="hidden" name="modelId" value={modelId} />
              <Button type="submit" size="xs" variant="destructive">Set as minor</Button>
            </form>
            <form method="POST" action="?/dismiss" use:enhance={submit(modelId, 'Dismissed')}>
              <input type="hidden" name="modelId" value={modelId} />
              <Button type="submit" size="xs" variant="outline">Dismiss match</Button>
            </form>
          {:else if data.tab === 'auto'}
            <form method="POST" action="?/confirm" use:enhance={submit(modelId, 'Kept flagged')}>
              <input type="hidden" name="modelId" value={modelId} />
              <Button type="submit" size="xs">Keep flagged</Button>
            </form>
            <form method="POST" action="?/revert" use:enhance={submit(modelId, 'Reverted')}>
              <input type="hidden" name="modelId" value={modelId} />
              <Button type="submit" size="xs" variant="destructive">Revert</Button>
            </form>
          {:else}
            <form method="POST" action="?/upholdAppeal" use:enhance={submit(modelId, 'Appeal rejected')}>
              <input type="hidden" name="modelId" value={modelId} />
              <Button type="submit" size="xs">Uphold flag</Button>
            </form>
            <form method="POST" action="?/overturnAppeal" use:enhance={submit(modelId, 'Appeal approved')}>
              <input type="hidden" name="modelId" value={modelId} />
              <Button type="submit" size="xs" variant="destructive">Overturn</Button>
            </form>
          {/if}
        </div>

        {#if expanded.has(modelId)}
          {#await details.get(modelId)}
            <p class="mt-3 text-sm text-dark-2">Loading detail…</p>
          {:then payload}
            {#if payload?.detail}
              {@const d = payload.detail}
              {@const m = payload.match}
              {@const ownVersion = n(row.modelVersionId) ?? m?.modelVersionId ?? null}
              {@const seedId = n(row.minorModelId) ?? m?.minorModelId ?? null}
              {@const seedVersion = n(row.minorModelVersionId) ?? m?.minorModelVersionId ?? null}
              {@const hash = s(row.hash) ?? m?.hash ?? null}
              <div class="mt-3 grid gap-4 border-t border-dark-4 pt-3 sm:grid-cols-2">
                <div>
                  <h4 class="mb-1 text-xs tracking-wide text-dark-2 uppercase">This model</h4>
                  {#if d.modelCoverUrl}
                    <!-- Fixed box, `object-contain`: the two covers are here to be COMPARED, so they
                         need the same frame, and cropping to fill it can hide the thing being judged.
                         Without an object-fit the `width` attribute and the height clamp fight and the
                         image renders stretched. -->
                    <div
                      class="mb-2 flex h-48 w-fit max-w-full items-center justify-center overflow-hidden rounded-md border border-dark-4 bg-dark-7"
                    >
                      <EdgeMedia
                        src={d.modelCoverUrl}
                        type={(d.modelCoverType ?? 'image') as 'image' | 'video'}
                        width={450}
                        class="h-full w-auto max-w-full object-contain"
                      />
                    </div>
                  {/if}
                  <p class="text-xs text-dark-2">
                    Uploaded {dateTime(d.modelCreatedAt)} · {s(row.status) ?? 'unknown'}
                  </p>
                  <p class="text-xs text-dark-2">
                    {s(row.username) ?? row.userId} · {num(d.uploaderModelCount)} model{d.uploaderModelCount ===
                    1
                      ? ''
                      : 's'} · joined {dateTime(d.uploaderJoinedAt)}
                  </p>
                  <a
                    href={modelHref(modelId, ownVersion ?? null)}
                    target="_blank"
                    rel="noreferrer"
                    class="mt-1 inline-block text-xs {LINK_CLASS}"
                  >
                    Open model ↗
                  </a>
                </div>

                {#if seedId}
                  <div>
                    <h4 class="mb-1 text-xs tracking-wide text-dark-2 uppercase">The flagged source</h4>
                    {#if d.minorModelCoverUrl}
                      <div
                        class="mb-2 flex h-48 w-fit max-w-full items-center justify-center overflow-hidden rounded-md border border-dark-4 bg-dark-7"
                      >
                        <EdgeMedia
                          src={d.minorModelCoverUrl}
                          type={(d.minorModelCoverType ?? 'image') as 'image' | 'video'}
                          width={450}
                          class="h-full w-auto max-w-full object-contain"
                        />
                      </div>
                    {/if}
                    <p class="text-xs text-dark-2">
                      {d.minorUsername ?? 'unknown'} · {d.minorModelStatus ?? 'unknown'}
                    </p>
                    <!-- The GAP between this and the copy's upload date is the evidence; a "deleted"
                         badge alone does not show they happened minutes apart. -->
                    {#if d.minorModelDeletedAt}
                      <p class="text-xs text-dark-2">Deleted {dateTime(d.minorModelDeletedAt)}</p>
                    {/if}
                    <!-- Only 2 of ~13.5k minor-locked models carry a setMinor ModActivity row, so a
                         placeholder here would read as missing data on nearly every row. -->
                    {#if d.minorFlaggedAt}
                      <p class="text-xs text-dark-2">
                        Set minor {dateTime(d.minorFlaggedAt)}{d.minorFlaggedByUsername
                          ? ` by ${d.minorFlaggedByUsername}`
                          : ''}
                      </p>
                    {/if}
                    <a
                      href={modelHref(seedId, seedVersion ?? null)}
                      target="_blank"
                      rel="noreferrer"
                      class="mt-1 inline-block text-xs {LINK_CLASS}"
                    >
                      Open flagged model ↗
                    </a>
                  </div>
                {:else if (s(row.flagConfirmedFrom) ?? s(row.flagSource) ?? 'auto') === 'manual'}
                  <div class="rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-200">
                    <strong class="block">No hash match</strong>
                    A moderator flagged this model directly rather than the automation matching it
                    against a known minor model, so there is no match to show — nothing is missing here.
                  </div>
                {:else}
                  <div class="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
                    <strong class="block">No matching flagged model</strong>
                    Nothing a moderator has flagged minor still shares a file with this model. The match
                    is resolved live, so the model it matched has since been unflagged or its hashes were
                    deleted — worth checking before you keep the flag.
                  </div>
                {/if}
              </div>

              {#if hash}
                <div class="mt-3">
                  <h4 class="text-xs font-semibold text-dark-2">Shared SHA256</h4>
                  <code class="text-xs break-all text-dark-0">{hash}</code>
                </div>
              {/if}
            {:else}
              <p class="mt-3 text-sm text-dark-2">No detail for this model.</p>
            {/if}
          {:catch}
            <p class="mt-3 text-sm text-red-300">Could not load the detail for this model.</p>
          {/await}
        {/if}
      </li>
    {/each}
  </ul>

  <div class="mt-4 flex flex-wrap items-center gap-3 text-sm">
    {#if data.page > 1}
      <a href={pageHref(data.page - 1)} class={LINK_CLASS}>← Previous</a>
    {/if}
    <span class="text-dark-2">
      {num(firstShown)}–{num(lastShown)}{counts ? ` of ${num(counts[data.tab])}` : ''}
    </span>
    {#if data.hasMore}
      <a href={pageHref(data.page + 1)} class={LINK_CLASS}>Next →</a>
    {/if}
  </div>

  {#if data.hasMore || data.page > 1}
    <!-- Offset paging over a queue being drained skips rows: acting on page 1 shifts everything up,
         so page 2 then starts past something never seen. -->
    <p class="mt-1 text-xs text-dark-3">
      After actioning rows, reload this page rather than paging forward — the queue shifts underneath
      the page boundary.
    </p>
  {/if}
{/if}
