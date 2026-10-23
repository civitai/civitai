<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { SvelteSet } from 'svelte/reactivity';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import TriagePageHeader from '$lib/components/triage/TriagePageHeader.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, num, plural, shortAge } from '$lib/format';
  import { denied } from '$lib/permissions';
  import { bulkReviewKeyAction, isDialogOpen, isTypingTarget } from '$lib/triage/keys';
  import { urlWith } from '$lib/url';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Unticked rather than ticked: every row starts ticked, since nearly all of them are scam accounts.
  // Cleared when the page's rows change, so a tick cannot carry over to a row it was not made on.
  const kept = new SvelteSet<number>();
  // The row the keys act on. Back to the top when the page's rows change.
  let cursor = $state(0);
  $effect(() => {
    void data.rows;
    kept.clear();
    cursor = 0;
  });
  const toBan = $derived(data.rows.filter((r) => !kept.has(r.id)));
  const toClear = $derived(data.rows.filter((r) => kept.has(r.id)));
  const toggle = (id: number) => (kept.has(id) ? kept.delete(id) : kept.add(id));

  const rowId = (id: number) => `scam-row-${id}`;
  // Keeps the cursor's row on screen as the keys move it; `scroll-my` keeps a margin past its edge.
  $effect(() => {
    const row = data.rows[cursor];
    if (row) document.getElementById(rowId(row.id))?.scrollIntoView({ block: 'nearest' });
  });

  function onkeydown(e: KeyboardEvent) {
    const target = e.target as Element | null;
    const action = bulkReviewKeyAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      defaultPrevented: e.defaultPrevented,
      isComposing: e.isComposing,
      typing: isTypingTarget(target),
      dialogOpen: isDialogOpen(),
      onControl: !!target?.closest('button, a') && !target.closest('[data-scam-row]'),
    });
    if (!action || !data.rows.length) return;
    // Also stops a focused tick box toggling itself on top of this. Focus inside a row (tabbed to its
    // tick box) makes that row the cursor's, so the key acts on the row the moderator is looking at.
    e.preventDefault();
    const focused = data.rows.findIndex((r) => target?.closest(`#${rowId(r.id)}`));
    if (focused >= 0 && action === 'toggle') cursor = focused;
    if (action === 'next') cursor = Math.min(cursor + 1, data.rows.length - 1);
    else if (action === 'previous') cursor = Math.max(cursor - 1, 0);
    else if (!e.repeat) toggle(data.rows[cursor].id);
  }

  type Failure = { id: number; username: string | null; error: string };
  let failures = $state<Failure[]>([]);
  // `reset: false`: the form's only fields are the hidden ids, and a reset empties them.
  const rule = new FormState({
    reset: false,
    reload: true,
    onSuccess: (result) => {
      const banned = Number(result?.banned ?? 0);
      const cleared = Number(result?.cleared ?? 0);
      failures = (result?.failed as Failure[] | undefined) ?? [];
      const done = [banned && `banned ${plural(banned, 'account')}`, cleared && `cleared ${num(cleared)}`]
        .filter(Boolean)
        .join(', ');
      if (done) toast.success(done[0].toUpperCase() + done.slice(1));
      if (failures.length) toast.error(`${plural(failures.length, 'restriction')} not done — see the list above`);
    },
  });

  let confirming = $state(false);
  let formEl = $state<HTMLFormElement | null>(null);

  const pageHref = (n: number) => urlWith(page.url, { page: n === 1 ? null : n });
  const first = $derived(data.offset + 1);
  const last = $derived(data.offset + data.rows.length);
</script>

<svelte:window {onkeydown} />

<div class="flex flex-col lg:h-svh">
  <TriagePageHeader
    title="Scam Restrictions"
    subtitle="Read each account's scanned text and untick any that is not a scam. Ticked accounts are banned as spam; unticked have their restriction lifted."
    placeholder="Username or user ID"
    searchLabel="Search scam restrictions"
  />

  <!-- The action bar stays on screen while the list scrolls under it. -->
  <form
    bind:this={formEl}
    method="POST"
    action="?/rule"
    use:enhance={rule.enhance}
    class="shrink-0 border-y border-dark-4 bg-dark-7 px-6 py-2.5"
  >
    {#each toBan as row (row.id)}<input type="hidden" name="ban" value={row.id} />{/each}
    {#each toClear as row (row.id)}<input type="hidden" name="clear" value={row.id} />{/each}

    <!-- The same column as the list, so the bar sits over what it acts on. -->
    <div class="mx-auto flex max-w-3xl flex-wrap items-center gap-3">
      <span class="text-sm text-dark-0 tabular-nums">
        {num(toBan.length)} to ban · {num(toClear.length)} to clear
      </span>
      <Button type="button" size="sm" variant="ghost" onclick={() => kept.clear()}>Tick all</Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onclick={() => data.rows.forEach((r) => kept.add(r.id))}
      >
        Untick all
      </Button>
      <span class="text-xs text-dark-2">J/K or ↑/↓ to move · Enter to tick or untick</span>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        class="ml-auto"
        disabled={!data.rows.length || rule.submitting || (toBan.length > 0 && !data.canBan)}
        onclick={() => (confirming = true)}
      >
        {rule.submitting
          ? 'Working…'
          : `Ban ${num(toBan.length)}${toClear.length ? `, clear ${num(toClear.length)}` : ''}`}
      </Button>
      {#if toBan.length && !data.canBan}
        <p class="m-0 w-full text-xs text-amber-300">{denied('audit.ban.execute')}</p>
      {/if}
    </div>
  </form>

  <div class="min-h-0 flex-1 overflow-y-auto bg-dark-8">
    <!-- A reading column: a page of profile text across a wide screen is hard to read. -->
    <div class="mx-auto max-w-3xl border-x border-dark-4 pb-6">
      {#if rule.error}<ErrorAlert class="mx-6 mt-3" message={rule.error} />{/if}
      {#if data.textFailed}
        <ErrorAlert
          class="mx-6 mt-3"
          message="The scanned text could not be loaded. Do not rule from this page until it does."
        />
      {/if}
      {#if failures.length}
        <div class="mx-6 mt-3 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          <p class="m-0 font-semibold">{plural(failures.length, 'restriction')} not done</p>
          <ul class="m-0 mt-1 list-disc pl-5">
            {#each failures as f (f.id)}
              <li>{f.username ?? `Restriction #${f.id}`}: {f.error}</li>
            {/each}
          </ul>
        </div>
      {/if}
  
      {#if data.rows.length}
        <ul class="m-0 list-none divide-y divide-dark-4 p-0">
          {#each data.rows as row, i (row.id)}
            {@const ban = !kept.has(row.id)}
            <!-- A click anywhere on the row moves the cursor to it; the tick box toggles it. -->
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
            <li
              id={rowId(row.id)}
              data-scam-row
              aria-current={i === cursor ? 'true' : undefined}
              onclick={() => (cursor = i)}
              class={cn(
                'flex scroll-my-12 gap-3 border-l-[3px] px-6 py-3',
                ban ? 'border-l-red-500' : 'border-l-green-500 bg-green-500/5',
                i === cursor && 'bg-dark-6 outline-2 -outline-offset-2 outline-blue-500'
              )}
            >
              <Checkbox
                id="scam-{row.id}"
                checked={ban}
                onCheckedChange={() => {
                  cursor = i;
                  toggle(row.id);
                }}
                aria-label="Ban {row.username ?? `user #${row.userId}`}"
                class="mt-0.5"
              />
              <div class="min-w-0 flex-1 space-y-2">
                <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                  <label for="scam-{row.id}" class="cursor-pointer font-semibold text-white">
                    {row.username ?? `User #${row.userId}`}
                  </label>
                  <span class="text-xs text-dark-2 tabular-nums">#{row.userId}</span>
                  <a href={userLookupUrl(row.username ?? row.userId)} class="text-xs {LINK_CLASS}">
                    User lookup
                  </a>
                  <span class="text-xs text-dark-2">
                    · account {shortAge(row.userCreatedAt)} old · restricted
                    <span title={dateTime(row.createdAt)}>{shortAge(row.createdAt)} ago</span>
                  </span>
                </div>
                {#if row.scanned.length}
                  <!-- Plain text, never the HTML: owner-written markup is not rendered in a moderator's
                       session. Link targets are shown inline, as the scan read them. -->
                  {#each row.scanned as field, i (i)}
                    <div class="rounded-md border border-dark-4 bg-dark-7 px-3 py-2">
                      <p class="m-0 text-[11px] font-semibold tracking-[0.5px] text-dark-2 uppercase">
                        {field.heading}
                      </p>
                      <p class="m-0 mt-0.5 text-[13px] break-words whitespace-pre-wrap text-dark-0">
                        {field.text}
                      </p>
                    </div>
                  {/each}
                {:else}
                  <p class="m-0 text-xs text-amber-300">
                    The scanned text is gone (cleared or deleted since the scan).
                  </p>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="p-10 text-center text-dark-0">
          {data.q ? `No pending scam restrictions match "${data.q}".` : 'No pending scam restrictions.'}
        </p>
      {/if}
    </div>
  </div>

  {#if data.rows.length}
    <footer
      class="shrink-0 border-t border-dark-4 bg-dark-7 px-6 py-2 text-xs text-dark-2"
    >
      <div class="mx-auto flex max-w-3xl items-center justify-between gap-3">
        <span class="tabular-nums">{num(first)} to {num(last)} of {num(data.totalCount)}</span>
        <span class="flex gap-2.5">
          {#if data.page > 1}<a href={pageHref(data.page - 1)} class={LINK_CLASS}>Prev</a>{:else}<span
              aria-disabled="true">Prev</span
            >{/if}
          {#if data.hasMore}<a href={pageHref(data.page + 1)} class={LINK_CLASS}>Next</a>{:else}<span
              aria-disabled="true">Next</span
            >{/if}
        </span>
      </div>
    </footer>
  {/if}
</div>

<AlertDialog.Root bind:open={confirming}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>
        Ban {plural(toBan.length, 'account')}{toClear.length ? `, clear ${num(toClear.length)}` : ''}?
      </AlertDialog.Title>
      <AlertDialog.Description>
        {#if toBan.length}
          {plural(toBan.length, 'account')} will be banned as spam, with their images, models and
          comments removed, and their restrictions upheld.
        {/if}
        {#if toClear.length}
          {plural(toClear.length, 'account')} will have the restriction overturned, which lifts the mute.
        {/if}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action
        variant="destructive"
        onclick={() => {
          confirming = false;
          formEl?.requestSubmit();
        }}
      >
        Confirm
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
