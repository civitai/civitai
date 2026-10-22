<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, num, plural } from '$lib/format';
  import { BROAD_ALIAS_WARNING, aliasBreadth, ruleMatchesText } from '$lib/model-rules';
  import type { ModelRuleView } from '$lib/server/model-rules.service';
  import { browserStorage } from '$lib/text-scan-lab/changes.svelte';
  import { buildApprovalPayload, newAliases, readApprovalResult } from './alias-approval';
  import { pendingSlot, runRuleSearch, type PendingSlot, type SearchRule } from './alias-client';
  import { createRunner, progressOf, type RuleRunStatus } from './alias-queue';
  import type { SearchOutcome } from './alias-search';
  import {
    aliasPendingKey,
    aliasSuggestionsKey,
    isStalePending,
    isStaleSuggestion,
    prunePending,
    pruneSuggestions,
    readPending,
    readSuggestions,
    searchFingerprint,
    setPending,
    writeSuggestions,
    type StoredSuggestions,
  } from './alias-suggestions-store';
  import { notifySaved } from './notify-saved';
  import { ALIAS_KIND_LABELS } from './suggest-aliases';

  let { rules, userId }: { rules: ModelRuleView[]; userId: number } = $props();

  // Each call is a billed web search; more than this at once only risks the main app's rate limit.
  const CONCURRENCY = 3;
  const storageKey = untrack(() => aliasSuggestionsKey(userId));
  const pendingKey = untrack(() => aliasPendingKey(userId));
  // Stop aborts this; polling items hand their workflow id back to storage and wait for a later visit.
  let controller = new AbortController();

  let showAll = $state(false);
  let q = $state('');
  let held = $state<Record<number, StoredSuggestions>>({});
  let statuses = $state<Record<number, RuleRunStatus>>({});
  let errors = $state<Record<number, string>>({});
  let picks = $state<Record<number, string[]>>({});
  let approveErrors = $state<Record<number, string>>({});
  let spent = $state(0);
  let kept = $state(true);
  const selected = new SvelteSet<number>();

  const eligible = $derived(rules.filter((rule) => rule.enabled && !rule.legacy));
  const shown = $derived(
    eligible.filter(
      (rule) =>
        (showAll || !rule.aliases.length || held[rule.id] || statuses[rule.id]) &&
        ruleMatchesText(rule, q)
    )
  );
  const progress = $derived(progressOf(Object.values(statuses)));
  const working = $derived(progress.remaining > 0);
  const fresh = $derived(
    eligible.filter((rule) => held[rule.id] && !isStale(held[rule.id], rule))
  );
  const payload = $derived(buildApprovalPayload(fresh, picks));
  const pickedCount = $derived(
    fresh.reduce((n, rule) => n + newAliases(rule.aliases, picks[rule.id] ?? []).length, 0)
  );

  // The backfill only ever uses the saved rule's text, so a search that ran on any other text
  // (an unsaved draft in the editor) must not resume or be applied here.
  const searchRuleOf = (rule: ModelRuleView): SearchRule => ({
    subject: rule.subject,
    description: rule.description,
    aliases: rule.aliases,
  });
  const isStale = (entry: StoredSuggestions, rule: ModelRuleView) =>
    isStaleSuggestion(entry, rule.updatedAt, searchFingerprint(searchRuleOf(rule)));

  onMount(() => {
    const current = untrack(() => rules);
    held = pruneSuggestions(readSuggestions(browserStorage(), storageKey), current);
    // A search submitted before a reload is still running (and billed): poll it, never submit again.
    const store = browserStorage();
    const pending = prunePending(readPending(store, pendingKey), current);
    const resume: number[] = [];
    for (const rule of current) {
      const entry = pending[rule.id];
      if (!entry) continue;
      if (isStalePending(entry, rule.updatedAt, searchFingerprint(searchRuleOf(rule))))
        setPending(store, pendingKey, rule.id, null);
      else if (rule.enabled && !rule.legacy && !held[rule.id]) resume.push(rule.id);
    }
    start(resume);
  });

  function persist() {
    kept = writeSuggestions(browserStorage(), storageKey, $state.snapshot(held));
  }

  const runner = createRunner<number, { slot: PendingSlot; outcome: SearchOutcome }>({
    concurrency: CONCURRENCY,
    worker: async (id) => {
      const rule = untrack(() => rules).find((r) => r.id === id);
      if (!rule) throw new Error('This rule no longer exists.');
      statuses[id] = 'running';
      const slot = pendingSlot(pendingKey, rule, searchRuleOf(rule));
      const outcome = await runRuleSearch({
        pathname: page.url.pathname,
        rule: searchRuleOf(rule),
        slot,
        signal: controller.signal,
      });
      return { slot, outcome };
    },
    // A finished call is billed, so its answer is stored before anything else can go wrong.
    onSettled: (id, settled) => {
      if (!settled.ok) {
        statuses[id] = 'failed';
        errors[id] = settled.error instanceof Error ? settled.error.message : 'The call failed.';
        return;
      }
      const { slot, outcome } = settled.value;
      if (outcome.status === 'stopped') {
        statuses[id] = 'idle';
        return;
      }
      if (outcome.status === 'failed') {
        statuses[id] = 'failed';
        errors[id] = outcome.error;
        return;
      }
      if (outcome.status === 'unresolved') {
        statuses[id] = 'failed';
        errors[id] = `${outcome.reason} The search is kept: Retry checks it again without paying twice.`;
        return;
      }
      spent += outcome.costTotal ?? 0;
      held[id] = {
        updatedAt: slot.updatedAt,
        fingerprint: slot.fingerprint,
        costTotal: outcome.costTotal,
        suggestions: outcome.suggestions,
      };
      delete picks[id];
      delete errors[id];
      statuses[id] = 'done';
      persist();
    },
  });

  function start(ids: number[]) {
    const idle = ids.filter((id) => statuses[id] !== 'queued' && statuses[id] !== 'running');
    for (const id of idle) {
      statuses[id] = 'queued';
      delete errors[id];
    }
    runner.enqueue(idle);
  }

  function stop() {
    for (const id of runner.stop()) statuses[id] = 'idle';
    controller.abort();
    controller = new AbortController();
  }

  function discard(id: number) {
    delete held[id];
    delete picks[id];
    delete statuses[id];
    persist();
  }

  function pick(id: number, alias: string, on: boolean) {
    const rest = (picks[id] ?? []).filter((a) => a !== alias);
    picks[id] = on ? [...rest, alias] : rest;
  }

  function applyResult(data: Record<string, unknown> | undefined) {
    const { saved, failed } = readApprovalResult(data);
    for (const id of saved) {
      delete held[id];
      delete picks[id];
      delete statuses[id];
      selected.delete(id);
    }
    approveErrors = failed;
    if (saved.length) persist();
  }

  const approve = new FormState({
    reload: true,
    reset: false,
    onSubmit: () => {
      approveErrors = {};
    },
    onSuccess: (data) => {
      applyResult(data);
      notifySaved(data);
    },
    onSettled: (result) => {
      if (result.type !== 'failure') return;
      applyResult(result.data);
      if ((result.data?.saved as unknown[] | undefined)?.length) void invalidateAll();
    },
  });

  const allShownSelected = $derived(shown.length > 0 && shown.every((r) => selected.has(r.id)));
  function toggleAll(on: boolean) {
    for (const rule of shown) {
      if (on) selected.add(rule.id);
      else selected.delete(rule.id);
    }
  }
  const STATUS_LABEL: Record<RuleRunStatus, string> = {
    idle: '',
    queued: 'Queued',
    running: 'Searching the web…',
    done: 'Suggested',
    failed: 'Failed',
  };
</script>

<section class="space-y-4 rounded-xl border border-dark-4 bg-dark-6 p-4">
  <div>
    <h2 class="text-base font-semibold text-white">Alias backfill</h2>
    <p class="text-sm text-dark-2">
      Suggest aliases for existing rules, tick the ones you want, then approve them in one save.
      Each rule costs one web-search call. Nothing is ticked for you.
    </p>
  </div>

  <div class="flex flex-wrap items-center gap-3">
    <Input bind:value={q} placeholder="Search rules" class="w-56" aria-label="Search rules" />
    <label class="flex items-center gap-2 text-sm text-dark-1">
      <Checkbox checked={showAll} onCheckedChange={(on) => (showAll = on === true)} />
      Show rules that already have aliases
    </label>
    <label class="flex items-center gap-2 text-sm text-dark-1">
      <Checkbox checked={allShownSelected} onCheckedChange={(on) => toggleAll(on === true)} />
      Select all shown
    </label>
    <span class="text-sm text-dark-2">{num(shown.length)} of {num(eligible.length)} rules</span>
  </div>

  <div class="flex flex-wrap items-center gap-3">
    <Button size="sm" disabled={!selected.size} onclick={() => start([...selected])}>
      Suggest for selected{selected.size ? ` (${selected.size})` : ''}
    </Button>
    <Button size="sm" variant="outline" disabled={!working} onclick={stop}>Stop</Button>
    {#if progress.total}
      <span class="text-sm text-dark-1" aria-live="polite">
        {progress.done} done · {progress.failed} failed · {progress.remaining} remaining
      </span>
    {/if}
    {#if spent}
      <span class="text-sm text-dark-2">Cost this session: {num(spent)}</span>
    {/if}
  </div>
  {#if working}
    <p class="text-xs text-dark-2">
      Stop skips rules not yet started and stops checking the ones running. Their searches are kept
      and resume the next time you open this page.
    </p>
  {/if}
  {#if !kept}
    <p class="text-sm text-yellow-300">
      This browser would not keep the suggestions. Approve them before reloading or they are lost.
    </p>
  {/if}

  <form method="POST" action="?/saveAll" use:enhance={approve.enhance} class="flex items-center gap-3">
    <input type="hidden" name="rules" value={JSON.stringify(payload)} />
    <Button type="submit" size="sm" disabled={!payload.length || approve.submitting}>
      {approve.submitting
        ? 'Saving…'
        : `Approve selected aliases${pickedCount ? ` (${plural(pickedCount, 'alias', 'aliases')})` : ''}`}
    </Button>
    <span class="text-xs text-dark-2">Saved like any rule edit: validated, versioned, cache cleared.</span>
  </form>
  {#if approve.error}
    <p class="whitespace-pre-wrap text-sm text-red-300">{approve.error}</p>
  {/if}

  {#if !shown.length}
    <p class="text-sm text-dark-2">
      {eligible.length ? 'No rules match these filters.' : 'No enabled rules.'}
    </p>
  {:else}
    <ul class="divide-y divide-dark-4" aria-label="Rules">
      {#each shown as rule (rule.id)}
        {@const entry = held[rule.id]}
        {@const stale = !!entry && isStale(entry, rule)}
        {@const status = statuses[rule.id] ?? 'idle'}
        <li class="space-y-2 py-3">
          <div class="flex flex-wrap items-center gap-2" data-touch-target>
            <Checkbox
              checked={selected.has(rule.id)}
              onCheckedChange={(on) => (on === true ? selected.add(rule.id) : selected.delete(rule.id))}
              aria-label="Select {rule.subject}"
            />
            <span class="break-words font-medium text-white">{rule.subject}</span>
            <span class="text-xs text-dark-2">{plural(rule.aliases.length, 'alias', 'aliases')}</span>
            {#if STATUS_LABEL[status]}
              <Badge variant="outline">{STATUS_LABEL[status]}</Badge>
            {/if}
            {#if entry}
              <Button size="xs" variant="ghost" onclick={() => discard(rule.id)}>Discard</Button>
            {/if}
          </div>

          {#if errors[rule.id]}
            <div class="flex flex-wrap items-center gap-2 text-sm text-red-300">
              <span>{errors[rule.id]}</span>
              <Button size="xs" variant="outline" onclick={() => start([rule.id])}>Retry</Button>
            </div>
          {/if}
          {#if approveErrors[rule.id]}
            <p class="text-sm text-red-300">Not saved: {approveErrors[rule.id]}</p>
          {/if}

          {#if entry}
            {#if stale}
              <p class="text-sm text-yellow-300">
                These were fetched for other text than this rule has now (it was edited, or the search ran on
                an unsaved draft), so they are out of date. Discard them and suggest again.
              </p>
            {/if}
            {#if !entry.suggestions.length}
              <p class="text-xs text-dark-2">No new aliases found.</p>
            {:else}
              <ul class="ml-6 space-y-1.5" aria-label="Suggested aliases for {rule.subject}">
                {#each entry.suggestions as suggestion (suggestion.alias)}
                  <li class="flex items-start gap-2" data-touch-target>
                    <Checkbox
                      checked={picks[rule.id]?.includes(suggestion.alias) ?? false}
                      disabled={stale}
                      onCheckedChange={(on) => pick(rule.id, suggestion.alias, on === true)}
                      aria-label="Approve {suggestion.alias}"
                    />
                    <div class="min-w-0 text-sm">
                      <span class="break-words text-white">{suggestion.alias}</span>
                      <Badge variant="outline" class="ml-1">{ALIAS_KIND_LABELS[suggestion.kind]}</Badge>
                      {#if suggestion.note}
                        <span class="ml-1 text-xs text-dark-2">{suggestion.note}</span>
                      {/if}
                      {#if suggestion.source}
                        <a
                          href={suggestion.source}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="{LINK_CLASS} ml-1 text-xs">source</a
                        >
                      {/if}
                      {#if aliasBreadth(suggestion.alias)}
                        <p class="text-xs text-yellow-300">{BROAD_ALIAS_WARNING}</p>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
