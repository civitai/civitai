<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import {
    RESOLUTION_NOTE_MAX_LENGTH,
    reasonRequiresNote,
    resolutionReasonsFor,
  } from '@civitai/shared/resolution-reasons';
  import { FormState } from '$lib/form-state.svelte';

  let {
    ticketId,
    userId,
    restrictionId,
    enabled,
    why,
    ondone,
  }: {
    ticketId: string;
    userId: number;
    restrictionId: number;
    /** False renders the controls disabled, with `why`. */
    enabled: boolean;
    why: string;
    ondone: (what: string, data: Record<string, unknown> | undefined) => void;
  } = $props();

  let verdict = $state('');
  let reason = $state('');
  let note = $state('');
  let confirming = $state(false);

  const reasons = $derived(
    verdict === 'Overturned' || verdict === 'Upheld' ? resolutionReasonsFor('restriction', verdict) : []
  );
  const picked = $derived(reasons.find((r) => r.value === reason));
  const ready = $derived(
    verdict !== '' && reason !== '' && (!reasonRequiresNote(reason) || note.trim() !== '')
  );

  const form = new FormState({
    // Enter in a text field submits without the confirm button; only that button's submit goes through.
    onSubmit: ({ cancel }) => {
      if (!confirming) cancel();
    },
    onSuccess: (data) => ondone(`Restriction ${verdict.toLowerCase()}`, data),
    onSettled: () => (confirming = false),
    reset: false,
  });
  const reasonWhy = $derived(enabled ? undefined : why);
</script>

<form method="POST" action="?/accountResolveRestriction" use:enhance={form.enhance} class="flex flex-col gap-1.5">
  <input type="hidden" name="ticketId" value={ticketId} />
  <input type="hidden" name="userId" value={userId} />
  <input type="hidden" name="userRestrictionId" value={restrictionId} />
  <Select.Root
    type="single"
    name="status"
    bind:value={
      () => verdict,
      (v) => {
        verdict = v;
        reason = '';
      }
    }
    disabled={!enabled || form.submitting}
  >
    <Select.Trigger class="h-8 w-full text-[13px]" aria-label="Ruling" title={reasonWhy}>
      {verdict === 'Overturned' ? 'Overturn (lift it)' : verdict === 'Upheld' ? 'Uphold (keep it)' : 'Rule on restriction #' + restrictionId}
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="Overturned">Overturn (lift it)</Select.Item>
      <Select.Item value="Upheld">Uphold (keep it)</Select.Item>
    </Select.Content>
  </Select.Root>
  <Select.Root type="single" name="resolvedReason" bind:value={reason} disabled={!enabled || form.submitting || !verdict}>
    <Select.Trigger class="h-8 w-full text-[13px]" aria-label="Reason" title={picked?.description ?? reasonWhy}>
      <span class="truncate">{picked?.label ?? 'Reason…'}</span>
    </Select.Trigger>
    <Select.Content>
      {#each reasons as r (r.value)}
        <Select.Item value={r.value} label={r.label} title={r.description}>{r.label}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
  <Input
    name="internalNotes"
    aria-label="Note for the record"
    maxlength={RESOLUTION_NOTE_MAX_LENGTH}
    bind:value={note}
    placeholder={reasonRequiresNote(reason) ? 'Say why (required)' : 'Note (optional, never shown to the user)'}
    disabled={!enabled || form.submitting}
    class="h-8 text-[13px]"
  />
  <!-- The confirm button is the only real submit; see TicketAccountAction. -->
  {#if confirming}
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="w-full text-xs text-red-300">
        {verdict === 'Overturned'
          ? 'The restriction is lifted and the user is told.'
          : 'The restriction stays and the user is told.'}
      </span>
      <Button type="submit" size="sm" disabled={form.submitting} data-touch-target>Yes, rule</Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={form.submitting}
        onclick={() => (confirming = false)}
        data-touch-target
      >
        Cancel
      </Button>
    </div>
  {:else}
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={!enabled || form.submitting || !ready}
      title={reasonWhy}
      onclick={() => (confirming = true)}
      data-touch-target
    >
      Rule…
    </Button>
  {/if}
  {#if form.error}<p class="m-0 text-xs text-red-300">{form.error}</p>{/if}
  {#if form.warning}<p class="m-0 text-xs text-amber-300">{form.warning}</p>{/if}
  {#if reasonWhy}<p class="m-0 text-[11px] text-amber-300">{reasonWhy}</p>{/if}
</form>
