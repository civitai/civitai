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
  import { LAB_ENTITY_TYPES, LAB_LABELS, type LabEntityType } from '$lib/text-scan-lab/types';

  let {
    overrides,
    overridesError,
    onstart,
    onchecked,
  }: {
    overrides: string;
    overridesError: string | null;
    onstart: () => void;
    onchecked: (result: Record<string, unknown>) => void;
  } = $props();

  let raw = $state('');
  let lookupAs = $state<LabEntityType>('Model');
  let judgeAs = $state<LabEntityType>('CommentV2');
  let profileAs = $state<'UserProfile' | 'User'>('UserProfile');

  const parsed = $derived(parseCheckInput(raw));
  const blocked = $derived(
    parsed.kind === 'empty' ||
      parsed.kind === 'too-many-ids' ||
      parsed.kind === 'refused' ||
      overridesError !== null
  );
  const judgedType = $derived.by((): LabEntityType | null => {
    switch (parsed.kind) {
      case 'ids':
        return lookupAs;
      case 'entity':
        return parsed.entityType;
      case 'user':
        return profileAs;
      case 'text':
      case 'unknown-url':
        return judgeAs;
      default:
        return null;
    }
  });

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
    onSuccess: (r) => r && onchecked(r),
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
  action="?/check"
  use:enhance={form.enhance}
  class="rounded-xl border border-dark-4 bg-dark-6 p-5"
>
  <input type="hidden" name="lookupAs" value={lookupAs} />
  <input type="hidden" name="judgeAs" value={judgeAs} />
  <input type="hidden" name="profileAs" value={profileAs} />
  <input type="hidden" name="overrides" value={overrides} />

  <Textarea
    name="input"
    aria-label="Link, id or text to check"
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
    {:else if parsed.kind === 'text' || parsed.kind === 'unknown-url'}
      {@render typeSelect(
        'judge-as',
        'Judge as',
        judgeAs,
        (v) => (judgeAs = v as LabEntityType),
        LAB_ENTITY_TYPES
      )}
    {/if}
    {#if judgedType}
      <p class="text-xs text-dark-2">
        Checks {LAB_LABELS[judgedType].map((l) => LABEL_NAMES[l]).join(', ')}
      </p>
    {/if}
  </div>

  {#if parsed.kind === 'unknown-url' || parsed.kind === 'refused'}
    <p class="mt-2 text-sm text-amber-300">{parsed.notice}</p>
  {:else if parsed.kind === 'too-many-ids'}
    <p class="mt-2 text-sm text-red-300">
      {parsed.count} ids is more than the {parsed.max} one check can take.
    </p>
  {/if}

  <div class="mt-4 flex items-center gap-3 border-t border-dark-4 pt-4">
    <Button type="submit" disabled={blocked || form.submitting}>
      {form.submitting ? 'Checking…' : 'Check'}
    </Button>
  </div>
  {#if overridesError}
    <p class="mt-3 text-sm text-red-300">{overridesError}</p>
  {/if}
  {#if form.error}
    <p class="mt-3 whitespace-pre-wrap text-sm text-red-300">{form.error}</p>
  {/if}
</form>
