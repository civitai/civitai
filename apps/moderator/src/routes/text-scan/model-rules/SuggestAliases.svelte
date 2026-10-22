<script lang="ts">
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { LINK_CLASS, plural } from '$lib/format';
  import { runRuleSearch, storedWorkflowId, type PendingSlot } from './alias-client';
  import { aliasPendingKey } from './alias-suggestions-store';
  import { parseAliases } from '$lib/model-rules';
  import { ALIAS_KIND_LABELS, type AliasSuggestion } from './suggest-aliases';

  let {
    id,
    subject,
    description,
    aliases,
    rule = null,
    onadd,
  }: {
    id: string | number;
    subject: string;
    description: string;
    aliases: string;
    /** The saved rule these fields belong to; a new rule has none, so its search cannot resume. */
    rule?: { id: number; updatedAt: Date | string } | null;
    /** Appends to the rule's alias field; nothing is saved until the rule is. */
    onadd: (aliases: string[]) => void;
  } = $props();

  let suggestions = $state<AliasSuggestion[] | null>(null);
  let searching = $state(false);
  let error = $state<string | null>(null);
  const selected = new SvelteSet<string>();
  const controller = new AbortController();

  const slot = $derived<PendingSlot | null>(
    rule
      ? {
          key: aliasPendingKey(page.data.user?.id ?? 0),
          ruleId: rule.id,
          updatedAt: new Date(rule.updatedAt).toISOString(),
        }
      : null
  );

  async function search() {
    if (searching) return;
    searching = true;
    error = null;
    suggestions = null;
    selected.clear();
    try {
      const outcome = await runRuleSearch({
        pathname: page.url.pathname,
        rule: { subject, description, aliases: parseAliases(aliases) },
        slot,
        signal: controller.signal,
      });
      if (outcome.status === 'done') suggestions = outcome.suggestions;
      else if (outcome.status === 'failed') error = outcome.error;
      else if (outcome.status === 'unresolved')
        error = `${outcome.reason} The search is kept: click again to check it without paying twice.`;
    } catch (e) {
      error = e instanceof Error ? e.message : 'The call failed.';
    } finally {
      searching = false;
    }
  }

  // A search submitted before a reload is still running and billed: poll it, never submit again.
  onMount(() => {
    if (untrack(() => storedWorkflowId(slot))) void search();
  });
  // Leaving the page keeps the stored workflow id; the next visit resumes it.
  onDestroy(() => controller.abort());

  function toggle(alias: string, on: boolean) {
    if (on) selected.add(alias);
    else selected.delete(alias);
  }

  function addSelected() {
    const added = (suggestions ?? []).filter((s) => selected.has(s.alias)).map((s) => s.alias);
    onadd(added);
    suggestions = (suggestions ?? []).filter((s) => !selected.has(s.alias));
    selected.clear();
  }
</script>

<div class="mt-2 space-y-2">
  <div class="flex items-center gap-2">
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={!subject.trim() || searching}
      onclick={search}
    >
      {searching ? 'Searching the web…' : 'Suggest aliases'}
    </Button>
    <span class="text-xs text-dark-2">One web-search call per click; it costs credits.</span>
  </div>

  {#if error}
    <p class="text-sm text-red-300">{error}</p>
  {/if}

  {#if suggestions}
    {#if !suggestions.length}
      <p class="text-xs text-dark-2">No new aliases found.</p>
    {:else}
      <ul class="space-y-1.5" aria-label="Suggested aliases">
        {#each suggestions as suggestion (suggestion.alias)}
          <li class="flex items-start gap-2" data-touch-target>
            <Checkbox
              id="suggest-{id}-{suggestion.alias}"
              checked={selected.has(suggestion.alias)}
              onCheckedChange={(on) => toggle(suggestion.alias, on === true)}
              aria-label="Add {suggestion.alias}"
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
            </div>
          </li>
        {/each}
      </ul>
      <Button size="xs" disabled={!selected.size} onclick={addSelected}>
        Add selected{selected.size ? ` (${plural(selected.size, 'alias', 'aliases')})` : ''}
      </Button>
    {/if}
  {/if}
</div>
