<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { denied } from '$lib/permissions';
  import { cancelUnlessConfirming } from '$lib/tickets/confirm-guard';

  let {
    ticketId,
    canEscalate,
    canReply,
    ondone,
  }: {
    ticketId: string;
    canEscalate: boolean;
    canReply: boolean;
    ondone: (what: string, data: Record<string, unknown> | undefined, status: number | null) => void;
  } = $props();

  type Route = {
    action: 'fileBug' | 'privacy' | 'modLead' | 'escalate';
    label: string;
    confirm: string;
    yes: string;
    done: string;
    /** The note is the report itself, so it cannot be empty. */
    needsNote?: boolean;
    /** It emails the requester. */
    emails?: boolean;
  };

  const ROUTES: Route[] = [
    {
      action: 'fileBug',
      label: 'Bug → dev queue…',
      confirm:
        'Files a bug report for the dev team from your note. The ticket stays here: reply to it or close it as usual.',
      yes: 'Yes, file the bug',
      done: 'Bug report filed',
      needsNote: true,
    },
    {
      action: 'privacy',
      label: 'Privacy / account deletion…',
      confirm:
        "Emails the requester Legal's acknowledgment and hands the ticket to Legal; it leaves both ticket views. Not for takedowns (DMCA, TAKE IT DOWN, likeness), law enforcement or CSAM.",
      yes: 'Yes, send to Legal',
      done: 'Sent to Legal',
      emails: true,
    },
    {
      action: 'modLead',
      label: 'Mod lead…',
      confirm: 'Sets "Waiting on Mod Lead" for the mod lead to pick up. Nothing is emailed.',
      yes: 'Yes, send to the mod lead',
      done: 'Sent to the mod lead',
    },
    {
      action: 'escalate',
      label: 'Send to support…',
      confirm: "Nothing is emailed, but the ticket leaves the moderators' queue.",
      yes: 'Yes, send to support',
      done: 'Sent to support',
    },
  ];

  let confirming = $state<Route | null>(null);
  let note = $state('');

  const form = new FormState({
    onSubmit: cancelUnlessConfirming(() => confirming !== null),
    onSuccess: (data) => {
      const route = confirming;
      note = '';
      ondone(route?.done ?? 'Handed off', data, null);
    },
    onSettled: () => (confirming = null),
  });

  const why = $derived(canEscalate ? undefined : denied('tickets.escalate'));
  const whyFor = (r: Route) => why ?? (r.emails && !canReply ? denied('tickets.reply') : undefined);
</script>

<form
  method="POST"
  action={confirming ? `?/${confirming.action}` : '?/escalate'}
  use:enhance={form.enhance}
  class="flex flex-col gap-1.5"
>
  <input type="hidden" name="ticketId" value={ticketId} />
  <Input
    name="reason"
    bind:value={note}
    maxlength={confirming?.action === 'fileBug' ? 1950 : 500}
    placeholder="Note (required for a bug report)"
    disabled={!canEscalate || form.submitting}
    title={why}
    class="h-8 text-[13px]"
  />
  {#if confirming}
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="w-full text-xs text-red-300">{confirming.confirm}</span>
      <Button
        type="submit"
        size="sm"
        disabled={form.submitting || (confirming.needsNote && !note.trim())}
        data-touch-target
      >
        {confirming.yes}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={form.submitting}
        onclick={() => (confirming = null)}
        data-touch-target
      >
        Cancel
      </Button>
      {#if confirming.needsNote && !note.trim()}
        <span class="w-full text-[11px] text-amber-300">Describe the bug in the note first.</span>
      {/if}
    </div>
  {:else}
    <div class="flex flex-wrap gap-1.5">
      {#each ROUTES as route (route.action)}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!!whyFor(route) || form.submitting}
          title={whyFor(route)}
          onclick={() => (confirming = route)}
          data-touch-target
        >
          {route.label}
        </Button>
      {/each}
    </div>
  {/if}
  {#if form.error}<p class="m-0 text-xs text-red-300">{form.error}</p>{/if}
  {#if form.warning}<p class="m-0 text-xs text-amber-300">{form.warning}</p>{/if}
  {#if why}<p class="m-0 text-[11px] text-amber-300">{why}</p>{/if}
</form>
