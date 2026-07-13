<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import PromptSegments from '$lib/components/PromptSegments.svelte';
  import { HIGHLIGHT_LEGEND, HIGHLIGHT_MARK } from '$lib/prompt-highlight';
  import type { PromptSegment } from '@civitai/mod-utils/prompt-audit';
  import type { ActionData } from './$types';

  let { form }: { form: ActionData } = $props();
  let input = $state('');

  const passed = $derived((form?.results ?? []).filter((r) => !r.includesInappropriate));
  const flagged = $derived((form?.results ?? []).filter((r) => r.includesInappropriate));
</script>

<header class="page-header">
  <h1>Prompt Tester</h1>
  <p class="text-sm text-muted-foreground">
    Test what the prompt audit flags — paste a single prompt, or a JSON array of
    <code class="rounded bg-muted px-1">{'{ prompt, negativePrompt }'}</code>.
  </p>
</header>

<div class="mb-4 flex flex-wrap gap-3">
  {#each HIGHLIGHT_LEGEND as l (l.cat)}
    <span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span class="inline-block size-3 rounded {HIGHLIGHT_MARK[l.cat]}"></span>{l.label}
    </span>
  {/each}
</div>

<form method="POST" action="?/audit" use:enhance class="mb-6 flex max-w-3xl flex-col gap-2">
  <Textarea
    name="input"
    bind:value={input}
    rows={6}
    placeholder={'a prompt to test…  or  [{ "prompt": "…", "negativePrompt": "…" }]'}
  />
  <div class="flex justify-end">
    <Button type="submit" disabled={input.trim().length === 0}>Run audit</Button>
  </div>
</form>

{#if form?.error}
  <div class="mb-4 max-w-3xl rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300">
    {form.error}
  </div>
{/if}

{#snippet resultCard(r: { promptSegments: PromptSegment[]; negativeSegments: PromptSegment[] | null })}
  <div class="rounded-lg border p-3">
    <PromptSegments segments={r.promptSegments} />
    {#if r.negativeSegments && r.negativeSegments.length > 0}
      <div class="mt-2 border-t border-border/60 pt-2">
        <span class="text-xs font-semibold uppercase text-muted-foreground">Negative</span>
        <PromptSegments segments={r.negativeSegments} />
      </div>
    {/if}
  </div>
{/snippet}

{#if form?.results}
  <div class="grid gap-6 md:grid-cols-2">
    <div class="flex flex-col gap-2">
      <h2 class="text-sm font-semibold uppercase text-emerald-400">Passed ({passed.length})</h2>
      {#each passed as r, i (i)}
        {@render resultCard(r)}
      {:else}
        <p class="text-sm text-muted-foreground">None.</p>
      {/each}
    </div>
    <div class="flex flex-col gap-2">
      <h2 class="text-sm font-semibold uppercase text-rose-400">Flagged ({flagged.length})</h2>
      {#each flagged as r, i (i)}
        {@render resultCard(r)}
      {:else}
        <p class="text-sm text-muted-foreground">None.</p>
      {/each}
    </div>
  </div>
{/if}
