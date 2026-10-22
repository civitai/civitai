<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { SvelteSet } from 'svelte/reactivity';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, plural } from '$lib/format';
  import { ALIAS_KIND_LABELS, type AliasSuggestion } from './suggest-aliases';

  let {
    id,
    subject,
    description,
    aliases,
    onadd,
  }: {
    id: string | number;
    subject: string;
    description: string;
    aliases: string;
    /** Appends to the rule's alias field; nothing is saved until the rule is. */
    onadd: (aliases: string[]) => void;
  } = $props();

  let suggestions = $state<AliasSuggestion[] | null>(null);
  const selected = new SvelteSet<string>();

  const form = new FormState({
    reset: false,
    onSubmit: () => {
      suggestions = null;
      selected.clear();
    },
    onSuccess: (data) => {
      suggestions = (data?.suggestions as AliasSuggestion[] | undefined) ?? [];
    },
  });

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
  <form method="POST" action="?/suggestAliases" use:enhance={form.enhance} class="flex items-center gap-2">
    <input type="hidden" name="subject" value={subject} />
    <input type="hidden" name="description" value={description} />
    <input type="hidden" name="aliases" value={aliases} />
    <Button type="submit" size="xs" variant="outline" disabled={!subject.trim() || form.submitting}>
      {form.submitting ? 'Searching the web…' : 'Suggest aliases'}
    </Button>
    <span class="text-xs text-dark-2">One web-search call per click; it costs credits.</span>
  </form>

  {#if form.error}
    <p class="text-sm text-red-300">{form.error}</p>
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
