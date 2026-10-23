<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { plural } from '$lib/format';
  import { parseCheckInput, type CheckInput } from '$lib/text-scan-lab/input';
  import { ENTITY_TYPE_NAMES, LABEL_NAMES } from '$lib/text-scan-lab/labels';
  import { judgeCandidates, sourceTypeOf } from '$lib/text-scan-lab/try';
  import {
    LAB_ENTITY_TYPES,
    LAB_LABELS,
    type LabEntityType,
    type PromptKey,
  } from '$lib/text-scan-lab/types';

  let {
    prompts,
    editedKeys,
    draftsError,
    onstart,
    onresult,
  }: {
    prompts: string;
    editedKeys: readonly PromptKey[];
    draftsError: string | null;
    onstart: () => void;
    onresult: (result: Record<string, unknown>) => void;
  } = $props();

  let raw = $state('');
  let lookupAs = $state<LabEntityType>('Model');
  let judgeAs = $state<LabEntityType>('CommentV2');
  let profileAs = $state<'UserProfile' | 'User'>('UserProfile');

  const parsed = $derived(parseCheckInput(raw));
  const runnable = $derived(
    parsed.kind !== 'empty' && parsed.kind !== 'too-many-ids' && parsed.kind !== 'refused'
  );
  const source = $derived(sourceTypeOf(parsed, { lookupAs, profileAs }));
  const candidates = $derived(judgeCandidates(source, editedKeys));
  const judged = $derived(candidates.includes(judgeAs) ? judgeAs : candidates[0]);

  const detected = (p: CheckInput): string | null => {
    switch (p.kind) {
      case 'ids':
        return plural(p.ids.length, 'id');
      case 'entity':
        return plural(p.ids.length, `${ENTITY_TYPE_NAMES[p.entityType].toLowerCase()} link`);
      case 'user':
        return `Profile link for ${p.username}`;
      case 'text':
        return 'Text';
      default:
        return null;
    }
  };
  const detectedText = $derived(detected(parsed));

  const form = new FormState({
    reset: false,
    onSubmit: () => onstart(),
    onSuccess: (r) => r && onresult(r),
  });
</script>

{#snippet typeSelect(
  id: string,
  label: string,
  value: string,
  set: (v: string) => void,
  types: readonly LabEntityType[]
)}
  <div class="flex items-center gap-2">
    <Label for={id} class="text-xs text-dark-2">{label}</Label>
    <Select.Root type="single" bind:value={() => value, set}>
      <Select.Trigger {id} class="h-8 w-48">
        {ENTITY_TYPE_NAMES[value as LabEntityType]}
      </Select.Trigger>
      <Select.Content>
        {#each types as type (type)}
          <Select.Item value={type}>{ENTITY_TYPE_NAMES[type]}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
{/snippet}

<form
  method="POST"
  action="?/try"
  use:enhance={form.enhance}
  class="rounded-xl border border-dark-4 bg-dark-6 p-5"
>
  <h2 class="mb-3 text-sm font-semibold text-white">Try</h2>
  <input type="hidden" name="lookupAs" value={lookupAs} />
  <input type="hidden" name="judgeAs" value={judged} />
  <input type="hidden" name="profileAs" value={profileAs} />
  <input type="hidden" name="prompts" value={prompts} />

  <Textarea
    name="input"
    aria-label="Link, id or text to try"
    placeholder="Paste a Civitai link, an id, or some text"
    class="min-h-28"
    bind:value={raw}
  />

  <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
    {#if detectedText}
      <p class="text-xs text-dark-2">{detectedText}</p>
    {/if}
    {#if parsed.kind === 'ids'}
      {@render typeSelect(
        'lookup-as',
        'Look up as',
        lookupAs,
        (v) => (lookupAs = v as LabEntityType),
        LAB_ENTITY_TYPES
      )}
    {:else if parsed.kind === 'user'}
      {@render typeSelect(
        'profile-as',
        'Look up as',
        profileAs,
        (v) => (profileAs = v as 'UserProfile' | 'User'),
        ['UserProfile', 'User']
      )}
    {/if}
    {#if runnable && candidates.length > 1}
      {@render typeSelect(
        'judge-as',
        'Judge as',
        judged,
        (v) => (judgeAs = v as LabEntityType),
        candidates
      )}
    {/if}
    {#if runnable}
      <p class="text-xs text-dark-2">
        Judged as {ENTITY_TYPE_NAMES[judged]} · checks
        {LAB_LABELS[judged].map((l) => LABEL_NAMES[l]).join(', ')}
      </p>
    {/if}
  </div>

  {#if parsed.kind === 'unknown-url' || parsed.kind === 'refused'}
    <p class="mt-2 text-sm text-amber-300">{parsed.notice}</p>
  {:else if parsed.kind === 'too-many-ids'}
    <p class="mt-2 text-sm text-red-300">
      {parsed.count} ids is more than the {parsed.max} one try can take.
    </p>
  {/if}

  <div class="mt-4 flex items-center gap-3 border-t border-dark-4 pt-4">
    <Button type="submit" disabled={!runnable || draftsError !== null || form.submitting}>
      {form.submitting ? 'Running…' : 'Run'}
    </Button>
  </div>
  {#if draftsError}
    <p class="mt-3 text-sm text-red-300">{draftsError}</p>
  {/if}
  {#if form.error}
    <p class="mt-3 whitespace-pre-wrap text-sm text-red-300">{form.error}</p>
  {/if}
</form>
