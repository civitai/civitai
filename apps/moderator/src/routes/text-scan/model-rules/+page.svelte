<script lang="ts">
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { enhance } from '$app/forms';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { LINK_CLASS, plural } from '$lib/format';
  import MatchesTab from './MatchesTab.svelte';
  import RulesTab from './RulesTab.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const canEdit = $derived(!!data.grants['textScan.modelRules.edit']);
  const tabHref = (tab: 'rules' | 'matches') => `?tab=${tab}`;
  let converting = $state(false);
</script>

<svelte:head><title>Model rules · Text scan</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
  <h1 class="text-xl font-semibold text-white">Model rules</h1>
  <p class="flex gap-4 text-sm">
    <a href="/text-scan/check" class={LINK_CLASS}>Check a model against the rules</a>
    <a href="/text-scan/prompts?key=label:modelRules" class={LINK_CLASS}>Instructions history</a>
  </p>
</div>

<nav class="mb-4 flex flex-wrap gap-1">
  {#each [['rules', 'Rules'], ['matches', 'Matches']] as const as [tab, label] (tab)}
    <a
      href={tabHref(tab)}
      class={cn(
        'rounded-md px-3 py-1 text-sm',
        tab === data.query.tab ? 'bg-dark-5 text-white' : 'text-dark-2 hover:bg-dark-6'
      )}
    >
      {label}
    </a>
  {/each}
</nav>

{#if form?.error}
  <ErrorAlert class="mb-4" message={form.error} />
{:else if form?.message}
  <div class="mb-4 rounded-md border border-teal-500/30 bg-teal-500/10 p-2 text-sm text-teal-300">
    {form.message}
    {#if form.cacheWarning}<span class="text-amber-300">{form.cacheWarning}</span>{/if}
  </div>
{/if}

{#if data.rules}
  {#if data.legacyCount > 0}
    <section
      class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"
    >
      <p class="text-sm text-amber-200">
        {data.legacyCount}
        {plural(data.legacyCount, 'rule')} still {data.legacyCount === 1 ? 'uses' : 'use'} regex.
        Converting rewrites them in place as plain-language rules and keeps the regex for reference.
      </p>
      {#if canEdit}
        <form
          method="POST"
          action="?/convert"
          use:enhance={() => {
            converting = true;
            return async ({ update }) => {
              try {
                await update();
              } finally {
                converting = false;
              }
            };
          }}
        >
          <Button type="submit" disabled={converting}>
            Convert {data.legacyCount} {plural(data.legacyCount, 'rule')}
          </Button>
        </form>
      {/if}
    </section>
  {/if}
  <RulesTab rules={data.rules} total={data.total} query={data.query} {canEdit} url={page.url} />
{:else if data.matches}
  <MatchesTab
    matches={data.matches}
    query={data.query}
    civitaiUrl={data.civitaiUrl}
    url={page.url}
  />
{/if}
