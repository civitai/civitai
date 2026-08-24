<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { SvelteSet } from 'svelte/reactivity';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import ImageFlagBadges from '$lib/components/ImageFlagBadges.svelte';
  import type { ActionData, PageData } from './$types';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { imageLookupUrl, userLookupUrl } from '$lib/entity-url';
  import { urlWith } from '$lib/url';
  import { BULK_SOURCE_LABELS, BULK_SOURCES } from './sources';
  import { DEFAULT_LIMIT, LIMIT_OPTIONS } from './limits';
  import ImageActionBar from '$lib/components/ImageActionBar.svelte';
  import ListFilterBar, { type FilterField } from '$lib/components/ListFilterBar.svelte';
  import { NsfwLevel } from '@civitai/shared';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Local mirrors so typing doesn't navigate. Keyed on the URL, NOT on `data`: this page's enhancer
  // reloads, so `data` is a new object after every remove/restore/flag — an effect watching it wipes a
  // half-typed id the moment the previous action's invalidation lands.
  let source = $state(untrack(() => data.source));
  let term = $state(untrack(() => data.q));
  const subject = $derived(page.url.search);
  $effect(() => {
    subject;
    untrack(() => {
      source = data.source;
      term = data.q;
    });
  });

  const selected = new SvelteSet<string | number>();

  // Same reason: a FAILED action also invalidates, and clearing on `data.batch` identity would empty
  // the selection under an error that says "narrow the selection".
  $effect(() => {
    subject;
    untrack(() => selected.clear());
  });

  // Restore is only safe on already-blocked images; the bar warns when a selection includes others.
  const blockedIds = $derived(
    new Set<string | number>(
      (data.batch?.items ?? []).filter((i) => i.ingestion === 'Blocked').map((i) => i.id)
    )
  );

  // Retool filtered the fetched batch client-side, and so does this: the batch is one query the
  // moderator already paid for, and re-running it per filter change would drop the selection they are
  // assembling. `matched` is shown against the loaded count, never the source total.
  let filters = $state<Record<string, string>>({});
  const filterFields: FilterField[] = [
    {
      kind: 'select',
      key: 'rating',
      label: 'Rating',
      options: [
        [String(NsfwLevel.PG), 'PG'],
        [String(NsfwLevel.PG13), 'PG-13'],
        [String(NsfwLevel.R), 'R'],
        [String(NsfwLevel.X), 'X'],
        [String(NsfwLevel.XXX), 'XXX'],
        [String(NsfwLevel.Blocked), 'Blocked'],
        ['0', 'Unrated'],
      ],
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Removed',
      options: [
        ['removed', "Only ToS'd"],
        ['live', 'Hide removed'],
      ],
    },
    { kind: 'search', key: 'q', label: 'Search prompt' },
  ];

  const filteredItems = $derived(
    (data.batch?.items ?? []).filter((i) => {
      if (filters.rating && i.nsfwLevel !== Number(filters.rating)) return false;
      if (filters.status === 'removed' && i.ingestion !== 'Blocked') return false;
      if (filters.status === 'live' && i.ingestion === 'Blocked') return false;
      // The negative prompt too: a blocked term sitting in the negative is the same finding, and
      // Retool's prompt search matched both.
      const q = filters.q?.trim().toLowerCase();
      if (q && !`${i.prompt ?? ''}\n${i.negativePrompt ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    })
  );

  const ownerOfImage = $derived(new Map((data.batch?.items ?? []).map((i) => [i.id, i.userId])));
  const selectedOwnerCount = $derived(
    new Set([...selected].map((id) => ownerOfImage.get(Number(id))).filter((id) => id != null)).size
  );

  // The account-wide removal is armed separately from everything else on the page: it is the only
  // action whose size is not what the grid shows.
  let nuking = $state(false);
  let nukeConfirm = $state('');
  $effect(() => {
    subject;
    untrack(() => {
      nuking = false;
      nukeConfirm = '';
    });
  });

  const onSubmit = new FormState({
    reload: true,
    // The account-wide form is torn down here too: a success does not change the URL, so the effect
    // above never fires and it would otherwise stay open and armed under its own success banner.
    onSuccess: () => {
      selected.clear();
      nuking = false;
      nukeConfirm = '';
    },
  });

  // `limit` is carried through a new search rather than reset: a moderator who raised it did so because
  // this account needs it, and every subsequent lookup on that account would otherwise snap back to 200.
  // Built from scratch rather than mutated: changing the source or the term makes `offset` — and any
  // stale term — describe a batch that no longer exists.
  const navigate = (value: string, limit: number) =>
    goto(
      urlWith(new URL(page.url.pathname, page.url), {
        source,
        q: value || null,
        limit: limit === DEFAULT_LIMIT ? null : limit,
      }),
      { keepFocus: true }
    );

  const search = (e: SubmitEvent) => {
    e.preventDefault();
    navigate(term.trim(), data.limit);
  };

  // Paging keeps the batch and changes only the window, so it mutates the URL rather than rebuilding
  // it — the opposite of `navigate`, which is changing WHICH batch is on screen.
  const paginate = (offset: number) =>
    goto(urlWith(page.url, { offset: offset || null }), { keepFocus: true });
</script>

<header class="page-header">
  <h1>Bulk Image Manager</h1>
  <p>
    Find every image on a post, model, model version, collection or account — then remove, restore or
    notify in one action.
  </p>
</header>

<form onsubmit={search} class="mb-6 flex max-w-2xl flex-wrap gap-2">
  <Select.Root type="single" bind:value={source}>
    <Select.Trigger class="w-52">{BULK_SOURCE_LABELS[source]}</Select.Trigger>
    <Select.Content>
      {#each BULK_SOURCES as s (s)}
        <Select.Item value={s}>{BULK_SOURCE_LABELS[s]}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
  {#if source === 'imageIds'}
    <!-- A single-line input strips newlines, and Firefox CONCATENATES the pasted lines — a column of
         ids becomes one number, which either overflows int4 or lands on an unrelated image. -->
    <Textarea bind:value={term} rows={3} placeholder="One id per line, or comma-separated" class="min-w-64 flex-1" />
  {:else}
    <Input bind:value={term} placeholder={BULK_SOURCE_LABELS[source]} class="min-w-48 flex-1" />
  {/if}
  <Button type="submit">Find images</Button>
</form>

{#if form?.error}
  <ErrorAlert class="mb-4" message={form.error} />
{:else}
  <!-- A warning no longer HIDES the success line. A removal that struck only some of its owners has
       two facts to report, and the one the moderator has to act on is not the one that succeeded. -->
  {#if form?.success}
    <div
      class="mb-4 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200"
      role="status"
    >
      <!-- The endpoint returns the images it FOUND, not the ones it changed. The already-blocked share
           is counted here before the write, so the number that changed is the one reported. -->
      {#if 'removed' in form && form.removed != null}
        {@const already = ('alreadyBlocked' in form ? form.alreadyBlocked : 0) ?? 0}
        Removed {num(form.removed - already)} images{already > 0
          ? ` — ${num(already)} of the ${num(form.removed)} submitted were already blocked`
          : ''}.
      {:else if 'restored' in form && form.restored != null}
        {@const wasBlocked = ('wasBlocked' in form ? form.wasBlocked : 0) ?? 0}
        Restored {num(form.restored)} images{form.restored > wasBlocked
          ? ` — ${num(form.restored - wasBlocked)} of them were not blocked`
          : ''}.
      {:else if 'flagged' in form && form.flagged != null}
        Updated flags on {num(form.flagged)} images.
      {:else if 'notified' in form && form.notified != null}
        Notified {num(form.notified)} owners.
      {:else if 'removedAll' in form && form.removedAll != null}
        Removed every image on {form.account} — {num(form.removedAll)} in total.
      {/if}
      {#if 'struck' in form && form.struck != null && form.struck > 0}
        Struck {num(form.struck)} owner{form.struck === 1 ? '' : 's'}.
      {/if}
    </div>
  {/if}
  {#if form && 'warning' in form && form.warning}
    <div
      class="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200"
      role="status"
    >
      {form.warning}
    </div>
  {/if}
{/if}

{#if data.notFound}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">
      No images found for <code>{data.q}</code> as a {BULK_SOURCE_LABELS[data.source].toLowerCase()}.
    </p>
  </section>
{:else if data.batch}
  {@const batch = data.batch}
  {@const first = batch.offset + 1}
  {@const last = batch.offset + batch.items.length}
  {@const pageCount = Math.max(1, Math.ceil(batch.total / data.limit))}
  {@const pageNumber = Math.floor(batch.offset / data.limit) + 1}
  <section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-1 text-sm font-semibold text-white">
      {#if batch.total > batch.items.length}
        Images {num(first)}–{num(last)} of {num(batch.total)}
      {:else}
        {num(batch.total)} images
      {/if}
    </h2>
    <p class="mb-3 text-xs text-dark-2">
      {#if batch.truncated || batch.offset > 0}
        <span class="text-amber-300">
          An action here covers only this page, not all {num(batch.total)}.
        </span>
      {:else}
        The whole set.
      {/if}
      Click an image to select it once a selection has started.
    </p>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <span class="text-xs text-dark-2">Load up to</span>
      <Select.Root
        type="single"
        value={String(data.limit)}
        onValueChange={(v) => navigate(term.trim(), Number(v))}
      >
        <Select.Trigger class="w-32">{num(data.limit)} images</Select.Trigger>
        <Select.Content>
          {#each LIMIT_OPTIONS as n (n)}
            <Select.Item value={String(n)}>{num(n)} images</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <span class="text-xs text-dark-2">per page</span>

      {#if batch.total > data.limit}
        <div class="ml-auto flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={batch.offset === 0}
            onclick={() => paginate(Math.max(0, batch.offset - data.limit))}
          >
            Previous
          </Button>
          <span class="text-xs text-dark-2">Page {num(pageNumber)} of {num(pageCount)}</span>
          <Button
            size="xs"
            variant="outline"
            disabled={!batch.truncated}
            onclick={() => paginate(batch.offset + data.limit)}
          >
            Next
          </Button>
        </div>
      {/if}
    </div>

    {#if data.owners.length}
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span class="text-xs tracking-wide text-dark-2 uppercase">Owners</span>
        {#each data.owners as owner (owner.id)}
          <span class="flex items-baseline gap-1">
            <a href={userLookupUrl(owner.username ?? owner.id)} class={LINK_CLASS}>
              {owner.username ?? `#${owner.id}`}
            </a>
            {#if owner.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
          </span>
        {/each}
      </div>
    {/if}
  </section>

  <ListFilterBar
    fields={filterFields}
    bind:values={filters}
    matched={filteredItems.length}
    total={batch.items.length}
  />

  {#if data.canAct}
    <!-- `selectable` is the FILTERED set, so "Select all" means what is on screen. That is the whole
         point of filtering to ToS'd before acting. -->
    <ImageActionBar
      {selected}
      selectable={filteredItems.map((i) => i.id)}
      onSubmit={onSubmit.enhance}
      submitting={onSubmit.submitting}
      ownerCount={selectedOwnerCount}
      blockedIds={blockedIds}
    />
  {/if}

  <!-- No selection without the actions: ticking a box with no action bar leaves the moderator in a
       mode where clicking an image toggles instead of opening it, for no reason. -->
  <ImageQueueGrid
    items={filteredItems}
    civitaiUrl={data.civitaiUrl}
    selected={data.canAct ? selected : undefined}
    card={imageCard}
    empty="No images in this batch."
    endLabel={batch.truncated ? null : 'End of batch.'}
  />

  {#if data.canAct && data.subjectUserId != null}
    {@const account = data.owners.find((o) => o.id === data.subjectUserId)}
    <!-- The one action that is NOT scoped to what is on screen, and the only one on this page that
         cannot be undone from it. BELOW the grid and behind a collapsed trigger: sitting above the
         images it was one mis-aimed click away from every per-selection button a moderator uses all
         day. Reaching it now costs a scroll past the work, which is the point. -->
    <section class="mt-6 rounded-xl border border-red-500/40 bg-red-500/5 p-5">
      <h2 class="mb-1 text-sm font-semibold text-white">Remove every image on this account</h2>
      <p class="mb-3 text-xs text-dark-2">
        Blocks all {num(data.subjectImageTotal ?? batch.total)} images this account owns, not only the
        {num(batch.items.length)} on this page. Images only — models, posts and articles are untouched;
        use Purge Content in User Lookup for those.
      </p>
      {#if !nuking}
        <Button size="sm" variant="outline" class="text-red-400 hover:text-red-300" onclick={() => (nuking = true)}>
          Remove all images…
        </Button>
      {:else}
        <form method="POST" action="?/removeAllForUser" use:enhance={onSubmit.enhance} class="grid gap-2">
          <input type="hidden" name="userId" value={data.subjectUserId} />
          <Input name="reason" placeholder="Reason (recorded with the removal)" class="max-w-lg" />
          <Input
            name="confirm"
            bind:value={nukeConfirm}
            placeholder="Type {account?.username ?? data.subjectUserId} to confirm"
            class="max-w-lg"
          />
          <div class="flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant="destructive"
              disabled={onSubmit.submitting || nukeConfirm.trim() === ''}
            >
              {onSubmit.submitting ? 'Removing…' : 'Remove every image'}
            </Button>
            <Button type="button" size="sm" variant="outline" onclick={() => (nuking = false)}>
              Cancel
            </Button>
          </div>
        </form>
      {/if}
    </section>
  {/if}
{/if}

{#snippet imageCard(img: {
  id: number;
  ingestion?: string;
  blockedFor?: string | null;
  needsReview?: string | null;
  createdAt?: Date;
  poi?: boolean;
  minor?: boolean;
  tosViolation?: boolean;
  prompt?: string | null;
  negativePrompt?: string | null;
  isProfilePicture?: boolean;
  hasConnection?: boolean;
})}
  <div class="flex flex-col gap-1.5 p-2 text-xs text-dark-2">
    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <ImageFlagBadges
        ingestion={img.ingestion}
        blockedFor={img.blockedFor}
        tosViolation={img.tosViolation}
        needsReview={img.needsReview}
        poi={img.poi}
        minor={img.minor}
      />
      <span>{dateTime(img.createdAt ?? null)}</span>
      <!-- New tab: this page's whole job is assembling a selection, and navigating away loses it. -->
      <a href={imageLookupUrl(img.id)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
        Lookup #{img.id}
      </a>
    </div>

    <!-- Removing either of these breaks something the owner did not upload: an account's avatar, or
         the image backing a bounty entry. -->
    {#if img.isProfilePicture || img.hasConnection}
      <div class="flex flex-wrap gap-1">
        {#if img.isProfilePicture}
          <span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">profile picture</span>
        {/if}
        {#if img.hasConnection}
          <span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">attached to entity</span>
        {/if}
      </div>
    {/if}

    {#if img.prompt}
      <p class="line-clamp-3 wrap-break-word text-dark-2" title={img.prompt}>{img.prompt}</p>
    {/if}
    <!-- Selected since the page was written and rendered nowhere. A prohibited term sitting in the
         negative is the same finding, and the prompt search above matches it either way. -->
    {#if img.negativePrompt}
      <p class="line-clamp-2 wrap-break-word text-dark-2" title={img.negativePrompt}>
        <span class="text-dark-2">neg:</span>
        {img.negativePrompt}
      </p>
    {/if}
  </div>
{/snippet}
