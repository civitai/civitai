<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import QuoteDialog from '$lib/components/text-scan-lab/QuoteDialog.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { num } from '$lib/format';
  import { QUOTE_ABOVE } from '$lib/text-scan-lab/limits';
  import {
    DEFAULT_HEADING,
    LAB_ENTITY_TYPES,
    LAB_LABELS,
    type LabEntityType,
    type PromptKey,
  } from '$lib/text-scan-lab/types';
  import type { ActionData } from './$types';
  import InlineOverrides from './InlineOverrides.svelte';
  import ItemResult from './ItemResult.svelte';

  let { data } = $props();

  type Mode = 'text' | 'entities';
  type Version = 'draft' | 'inline';
  type RunData = Extract<NonNullable<ActionData>, { ran: true }>;
  type QuoteData = Extract<NonNullable<ActionData>, { needsConfirm: true }>;

  let entityType = $state<LabEntityType>('Model');
  let mode = $state<Mode>('text');
  let nextFieldId = 1;
  let fields = $state([{ id: 0, heading: DEFAULT_HEADING.Model, text: '' }]);
  let ids = $state('');
  let version = $state<Version>(untrack(() => (data.drafts.length ? 'draft' : 'inline')));
  let draftId = $state(
    untrack(() => String(data.selectedDraftId ?? data.drafts.find((d) => !d.published)?.id ?? ''))
  );
  let overrides = $state<Partial<Record<PromptKey, string>>>({});

  let pendingQuote = $state<QuoteData | null>(null);
  let lastRun = $state<{ run: RunData; quotedCost: number | null } | null>(null);

  const draft = $derived(data.drafts.find((d) => String(d.id) === draftId));

  function setEntityType(next: LabEntityType) {
    // A heading still at the old type's default follows the type; one the moderator typed stays.
    fields = fields.map((f) =>
      f.heading === DEFAULT_HEADING[entityType] ? { ...f, heading: DEFAULT_HEADING[next] } : f
    );
    entityType = next;
  }

  const runForm = new FormState({
    reset: false,
    onSuccess: (result) => {
      const r = result as NonNullable<ActionData>;
      if (r.needsConfirm) {
        pendingQuote = r;
      } else if (r.ran) {
        lastRun = { run: r, quotedCost: pendingQuote?.cost ?? null };
        pendingQuote = null;
      }
    },
    // The refusal renders under the form, which the open dialog would cover.
    onSettled: (result) => {
      if (result.type !== 'success') pendingQuote = null;
    },
  });
</script>

<svelte:head><title>Text-scan playground</title></svelte:head>

<h1 class="mb-4 text-xl font-semibold text-white">Text-scan playground</h1>

<form
  id="playground-run"
  method="POST"
  action="?/run"
  use:enhance={runForm.enhance}
  class="rounded-xl border border-dark-4 bg-dark-6 p-5"
>
  <input type="hidden" name="entityType" value={entityType} />
  <input type="hidden" name="mode" value={mode} />
  <input type="hidden" name="version" value={version} />
  {#if mode === 'text'}
    <input type="hidden" name="fields" value={JSON.stringify(fields)} />
  {/if}
  {#if version === 'draft'}
    <input type="hidden" name="draftId" value={draftId} />
  {:else}
    <input type="hidden" name="overrides" value={JSON.stringify(overrides)} />
  {/if}

  <div class="grid gap-6 lg:grid-cols-2">
    <div class="space-y-3">
      <div class="flex flex-wrap items-end gap-4">
        <div class="flex flex-col gap-1">
          <Label for="entity-type" class="text-xs text-dark-2">Entity type</Label>
          <Select.Root
            type="single"
            bind:value={() => entityType, (v) => setEntityType(v as LabEntityType)}
          >
            <Select.Trigger id="entity-type" class="w-48">{entityType}</Select.Trigger>
            <Select.Content>
              {#each LAB_ENTITY_TYPES as type (type)}
                <Select.Item value={type}>{type}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <p class="pb-2 text-xs text-dark-2">Labels: {LAB_LABELS[entityType].join(', ')}</p>
      </div>

      <Tabs value={mode} onValueChange={(v) => (mode = v as Mode)}>
        <TabsList>
          <TabsTrigger value="text">Text</TabsTrigger>
          <TabsTrigger value="entities">Entities</TabsTrigger>
        </TabsList>
      </Tabs>

      {#if mode === 'text'}
        {#each fields as field, i (field.id)}
          <div>
            <div class="flex items-center gap-2">
              <!-- Enter here would implicitly submit a billed run. -->
              <Input
                aria-label="Field heading"
                onkeydown={(e) => e.key === 'Enter' && e.preventDefault()}
                class="h-8 w-64 text-xs"
                bind:value={() => field.heading, (v) => (fields[i].heading = v)}
              />
              {#if fields.length > 1}
                <Button
                  size="xs"
                  variant="ghost"
                  onclick={() => (fields = fields.filter((f) => f.id !== field.id))}
                >
                  Remove
                </Button>
              {/if}
            </div>
            <Textarea
              aria-label="{field.heading} text"
              class="mt-1 min-h-24"
              bind:value={() => field.text, (v) => (fields[i].text = v)}
            />
          </div>
        {/each}
        <Button
          size="sm"
          variant="outline"
          onclick={() => (fields = [...fields, { id: nextFieldId++, heading: '', text: '' }])}
        >
          Add field
        </Button>
      {:else}
        <Label for="entity-ids" class="text-xs text-dark-2">
          {entityType} ids — comma or newline separated, up to 50
        </Label>
        <Textarea id="entity-ids" name="ids" class="min-h-24 font-mono" bind:value={ids} />
        <p class="text-xs text-dark-2">
          Each entity's text is composed exactly as the live scan composes it.
        </p>
      {/if}
    </div>

    <div class="space-y-3">
      <p class="text-sm text-dark-0">A runs the active prompts. B runs:</p>
      <Tabs value={version} onValueChange={(v) => (version = v as Version)}>
        <TabsList>
          <TabsTrigger value="draft">A draft</TabsTrigger>
          <TabsTrigger value="inline">Inline overrides</TabsTrigger>
        </TabsList>
      </Tabs>

      {#if version === 'draft'}
        {#if data.drafts.length}
          <Select.Root type="single" bind:value={draftId}>
            <Select.Trigger class="w-full" aria-label="Draft">
              {draft ? draft.name : 'Choose a draft'}
            </Select.Trigger>
            <Select.Content>
              {#each data.drafts as d (d.id)}
                <Select.Item value={String(d.id)}>
                  {d.name}{d.published ? ' (published)' : ''}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          {#if draft}
            <p class="text-xs text-dark-2">
              Overrides {draft.keys.join(', ') || 'nothing — it would run active'}.
              <a href="/text-scan/prompts?draft={draft.id}" class="text-blue-4 hover:underline"
                >Edit draft</a
              >
            </p>
          {/if}
        {:else}
          <p class="text-sm text-dark-2">
            No drafts yet — create one on <a href="/text-scan/prompts" class="text-blue-4 hover:underline"
              >Prompts</a
            >, or use inline overrides.
          </p>
        {/if}
      {:else}
        <InlineOverrides bind:overrides active={data.activePrompts} />
      {/if}
    </div>
  </div>

  <div class="mt-5 flex flex-wrap items-center gap-3 border-t border-dark-4 pt-4">
    <Button type="submit" disabled={runForm.submitting}>
      {runForm.submitting ? 'Running…' : 'Run A and B'}
    </Button>
    <p class="text-xs text-dark-2">
      Each item is two billed scans, one per version. Over {QUOTE_ABOVE} items you confirm a quote
      first.
    </p>
  </div>
  {#if runForm.error}
    <p class="mt-3 whitespace-pre-wrap text-sm text-red-300">{runForm.error}</p>
  {/if}
</form>

<QuoteDialog
  quote={pendingQuote}
  formId="playground-run"
  title="Run {pendingQuote?.count} items?"
  submitting={runForm.submitting}
  onclose={() => (pendingQuote = null)}
>
  {(pendingQuote?.count ?? 0) * 2} billed scans (A and B per item).
  {#if pendingQuote?.skipped.length}
    Skipped: {pendingQuote.skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}.
  {/if}
</QuoteDialog>

{#if lastRun}
  {@const run = lastRun.run}
  <div class="mt-6 space-y-4">
    <p class="text-sm text-dark-2">
      {run.entityType} · {run.items.length} item{run.items.length === 1 ? '' : 's'} ·
      up to {run.items.length * 2} billed scans{lastRun.quotedCost !== null
        ? ` · quoted ≈ ${num(Math.ceil(lastRun.quotedCost))} Buzz`
        : ''} · B = {run.versionB.name} ({run.versionB.keys.join(', ')})
    </p>
    {#if run.skipped.length}
      <p class="text-sm text-amber-300">
        Not scanned:
        {run.skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}
      </p>
    {/if}
    {#if run.errors.a}
      <p class="whitespace-pre-wrap text-sm text-red-300">A · Active failed: {run.errors.a}</p>
    {/if}
    {#if run.errors.b}
      <p class="whitespace-pre-wrap text-sm text-red-300">
        B · {run.versionB.name} failed: {run.errors.b}
      </p>
    {/if}
    <!-- A new run starts every item's save form afresh, even where an item key repeats. -->
    {#key lastRun}
      {#each run.items as item (item.key)}
        <ItemResult
          {item}
          entityType={run.entityType}
          labels={run.labels}
          versionB={run.versionB.name}
          testSets={data.testSets}
        />
      {/each}
    {/key}
  </div>
{/if}
