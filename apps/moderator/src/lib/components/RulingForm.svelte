<script module lang="ts">
  export type RulingDraft<V extends string = string> = {
    verdict: V | null;
    reason: string;
    note: string;
  };

  export const emptyRulingDraft = <V extends string>(): RulingDraft<V> => ({
    verdict: null,
    reason: '',
    note: '',
  });
</script>

<script lang="ts" generics="S extends ResolutionSubject">
  import type { Snippet } from 'svelte';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  // Used by the `generics=` attribute above, which ESLint cannot see.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  import type { ResolutionSubject } from '@civitai/shared/resolution-reasons';
  import {
    resolutionReasonError,
    type ResolutionVerdict,
  } from '@civitai/shared/resolution-reasons';
  import type { RulingChoice } from '$lib/ruling-choices';
  import ResolutionReasonFields from './ResolutionReasonFields.svelte';

  type Verdict = ResolutionVerdict<S>;

  let {
    subject,
    choices,
    action,
    enhancer,
    idPrefix,
    disabled = false,
    busy = false,
    size = 'sm',
    hidden,
    extra,
    draft = $bindable(emptyRulingDraft<Verdict>()),
  }: {
    subject: S;
    choices: readonly RulingChoice<Verdict>[];
    action: string;
    enhancer: SubmitFunction;
    /** Unique per mounted form, so two on one page do not share label targets. */
    idPrefix: string;
    /** Disables the controls but keeps the form mounted, so an in-flight submit can finish. */
    disabled?: boolean;
    /** The ruling is submitting; the confirm button says so. */
    busy?: boolean;
    size?: 'sm' | 'xs';
    /** The subject's ids, and anything else the action reads that the moderator does not type. */
    hidden: Snippet;
    /** Extra fields inside the form, after the reason. */
    extra?: Snippet;
    /** Bindable so a caller whose form unmounts on submit can keep the moderator's input. */
    draft?: RulingDraft<Verdict>;
  } = $props();

  const chosen = $derived(choices.find((c) => c.verdict === draft.verdict));
  const unrecordable = $derived(
    chosen ? resolutionReasonError(subject, chosen.verdict, draft.reason, draft.note) : null
  );

  // A reason and note are written for one verdict; a switch must not carry them to the other.
  const choose = (verdict: Verdict) => {
    draft = { verdict: draft.verdict === verdict ? null : verdict, reason: '', note: '' };
  };
</script>

<div class="grid gap-2">
  <div class="flex flex-wrap gap-1.5">
    {#each choices as c (c.verdict)}
      <Button
        {size}
        variant={draft.verdict === c.verdict ? c.variant : 'outline'}
        aria-pressed={draft.verdict === c.verdict}
        {disabled}
        onclick={() => choose(c.verdict)}
      >
        {c.label}
      </Button>
    {/each}
  </div>
  {#if chosen}
    <form
      method="POST"
      {action}
      use:enhance={enhancer}
      class="grid gap-2 rounded-md border border-dark-4 bg-dark-7 p-3"
    >
      {@render hidden()}
      <input type="hidden" name="status" value={chosen.verdict} />
      <ResolutionReasonFields
        {subject}
        verdict={chosen.verdict}
        {idPrefix}
        bind:reason={() => draft.reason, (reason) => (draft = { ...draft, reason })}
        bind:note={() => draft.note, (note) => (draft = { ...draft, note })}
      />
      {@render extra?.()}
      <div>
        <Button
          type="submit"
          {size}
          variant={chosen.variant}
          disabled={disabled || !!unrecordable}
        >
          {busy ? chosen.pendingLabel : chosen.confirmLabel}
        </Button>
      </div>
    </form>
  {/if}
</div>
