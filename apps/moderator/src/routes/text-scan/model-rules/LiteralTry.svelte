<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import HighlightedFields from '$lib/components/model-rule-holds/HighlightedFields.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { plural } from '$lib/format';
  import { matchedRules, type LiteralTryResult } from './literal-try';

  let { rules, editedCount }: { rules: string; editedCount: number } = $props();

  let raw = $state('');
  let result = $state<LiteralTryResult | null>(null);
  let ranWith = $state<string | null>(null);

  const stale = $derived(ranWith !== null && ranWith !== rules);

  const form = new FormState({
    reset: false,
    onSubmit: () => {
      result = null;
      ranWith = rules;
    },
    onSuccess: (r) => r && (result = r as unknown as LiteralTryResult),
  });
</script>

<section class="min-w-0 space-y-4" aria-label="Try">
  <form
    method="POST"
    action="?/try"
    use:enhance={form.enhance}
    class="rounded-xl border border-dark-4 bg-dark-6 p-5"
  >
    <h2 class="text-sm font-semibold text-white">Try</h2>
    <p class="mt-1 mb-3 text-xs text-dark-2">
      Which rules a model's text matches, as a publish would find them. Paste a model link, an id,
      or some text.
      {#if editedCount}
        Includes your {plural(editedCount, 'unsaved rule edit')}.
      {/if}
    </p>
    <input type="hidden" name="rules" value={rules} />
    <Textarea
      name="input"
      aria-label="Model link, id or text to try"
      placeholder="Paste a model link, an id, or some text"
      class="min-h-28"
      bind:value={raw}
    />
    <div class="mt-4 flex items-center gap-3 border-t border-dark-4 pt-4">
      <Button type="submit" disabled={!raw.trim() || form.submitting}>
        {form.submitting ? 'Running…' : 'Run'}
      </Button>
    </div>
    {#if form.error}
      <p class="mt-3 whitespace-pre-wrap text-sm text-red-300">{form.error}</p>
    {/if}
  </form>

  {#if result}
    {#if result.notice}
      <p class="text-sm text-amber-300">{result.notice}</p>
    {/if}
    {#if result.skipped.length}
      <p class="whitespace-pre-wrap text-sm text-amber-300">
        Couldn't load: {result.skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}
      </p>
    {/if}
    {#if stale}
      <p class="text-sm text-amber-300">
        Your rule edits changed after this run, so it no longer shows their effect. Run it again.
      </p>
    {/if}
    <p class="text-xs text-dark-2">Judged against {plural(result.rules.length, 'enabled rule')}.</p>
    {#each result.items as item (item.key)}
      {@const matched = matchedRules(item.matches, result.rules)}
      <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
        <h3 class="text-sm font-semibold text-white">{item.title}</h3>
        {#if matched.length}
          <ul class="mt-3 space-y-1">
            {#each matched as rule (rule.ruleId)}
              <li class="text-sm text-dark-0">
                <span class="font-medium text-white">{rule.subject}</span>
                {#each rule.terms as term (term)}
                  <Badge variant="outline" class="ml-1">{term}</Badge>
                {/each}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="mt-3 text-sm text-green-300">No rule matched.</p>
        {/if}
        <div class="mt-4">
          <HighlightedFields fields={item.fields} matches={item.matches} />
        </div>
      </section>
    {/each}
  {/if}
</section>
