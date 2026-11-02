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

  /** A reason and note are written for one verdict: switching drops them, and choosing it again
   *  clears it. */
  export const chooseVerdict = <V extends string>(
    draft: RulingDraft<V>,
    verdict: V
  ): RulingDraft<V> => ({ verdict: draft.verdict === verdict ? null : verdict, reason: '', note: '' });
</script>

<script lang="ts" generics="S extends ResolutionSubject">
  import type { Snippet } from 'svelte';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Kbd } from '@civitai/ui/components/ui/kbd/index.js';
  import { cn } from '@civitai/ui/utils.js';
  // Used by the `generics=` attribute above, which ESLint cannot see.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  import type { ResolutionSubject } from '@civitai/shared/resolution-reasons';
  import {
    resolutionReasonError,
    type ResolutionVerdict,
    type TextScanLabel,
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
    kbd = false,
    labels,
    choiceDisabled,
    hidden,
    extra,
    confirm = false,
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
    size?: 'sm' | 'xs' | 'lg';
    /** Shows each choice's digit key; the queue maps the keys to the same order. */
    kbd?: boolean;
    /** The flags being ruled on; reasons bound to another flag are neither offered nor accepted. */
    labels?: readonly TextScanLabel[];
    /** Why one choice is unavailable, shown as its title, or null when it is available. */
    choiceDisabled?: (verdict: Verdict) => string | null;
    /** The subject's ids, and anything else the action reads that the moderator does not type. */
    hidden: Snippet;
    /** Extra fields inside the form, after the reason. */
    extra?: Snippet;
    /** Submitting takes a second click ("Rule…" then "Yes, rule"), for rulings that notify the user and cannot be taken back. */
    confirm?: boolean;
    /** Bindable so a caller whose form unmounts on submit can keep the moderator's input. */
    draft?: RulingDraft<Verdict>;
  } = $props();

  const chosen = $derived(choices.find((c) => c.verdict === draft.verdict));
  const unrecordable = $derived(
    chosen
      ? (choiceDisabled?.(chosen.verdict) ??
          resolutionReasonError(subject, chosen.verdict, draft.reason, draft.note, labels))
      : null
  );
  const large = $derived(size === 'lg');

  const choose = (verdict: Verdict) => (draft = chooseVerdict(draft, verdict));

  let confirming = $state(false);
  // A confirmation belongs to the verdict it was asked for. Tracked through a derived value so editing
  // the reason or note, which replaces `draft`, does not cancel it.
  const verdict = $derived(draft.verdict);
  $effect(() => {
    void verdict;
    confirming = false;
  });

  // Enter in a text field submits without the confirm button; only that button's submit may go through.
  const submitEnhancer: SubmitFunction = (input) => {
    if (!confirm) return enhancer(input);
    if (!confirming) return input.cancel();
    const settle = enhancer(input);
    return async (opts) => {
      confirming = false;
      const after = await settle;
      await after?.(opts);
    };
  };
</script>

<div class={cn('grid gap-2', large && 'w-full')}>
  <div class={cn('flex flex-wrap', large ? 'gap-3' : 'gap-1.5')}>
    {#each choices as c, i (c.verdict)}
      {@const unavailable = choiceDisabled?.(c.verdict) ?? null}
      <Button
        {size}
        class={large ? 'h-11 px-5 text-base' : undefined}
        variant={draft.verdict === c.verdict ? c.variant : 'outline'}
        aria-pressed={draft.verdict === c.verdict}
        disabled={disabled || !!unavailable}
        title={unavailable ?? undefined}
        onclick={() => choose(c.verdict)}
        data-touch-target
      >
        {c.label}
        {#if kbd}<Kbd>{i + 1}</Kbd>{/if}
      </Button>
    {/each}
  </div>
  {#if chosen}
    <form
      method="POST"
      {action}
      use:enhance={submitEnhancer}
      class="grid gap-2 rounded-md border border-dark-4 bg-dark-7 p-3"
    >
      {@render hidden()}
      <input type="hidden" name="status" value={chosen.verdict} />
      <ResolutionReasonFields
        {subject}
        verdict={chosen.verdict}
        {idPrefix}
        {labels}
        bind:reason={() => draft.reason, (reason) => (draft = { ...draft, reason })}
        bind:note={() => draft.note, (note) => (draft = { ...draft, note })}
      />
      {@render extra?.()}
      {#if confirm && !confirming}
        <div>
          <Button
            type="button"
            {size}
            class={large ? 'h-11 px-5 text-base' : undefined}
            variant="outline"
            disabled={disabled || !!unrecordable}
            onclick={() => (confirming = true)}
            data-touch-target
          >
            Rule…
          </Button>
        </div>
      {:else}
        <div class="flex flex-wrap items-center gap-1.5">
          <Button
            type="submit"
            {size}
            class={large ? 'h-11 px-5 text-base' : undefined}
            variant={chosen.variant}
            disabled={disabled || !!unrecordable}
            data-touch-target
          >
            {confirm && !busy ? 'Yes, rule' : busy ? chosen.pendingLabel : chosen.confirmLabel}
          </Button>
          {#if confirm}
            <Button
              type="button"
              {size}
              class={large ? 'h-11 px-5 text-base' : undefined}
              variant="outline"
              disabled={disabled}
              onclick={() => (confirming = false)}
              data-touch-target
            >
              Cancel
            </Button>
          {/if}
        </div>
      {/if}
    </form>
  {/if}
</div>
