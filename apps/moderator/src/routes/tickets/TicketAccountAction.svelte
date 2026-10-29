<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { FormState } from '$lib/form-state.svelte';

  let {
    ticketId,
    userId,
    action,
    label,
    confirmText,
    doneLabel,
    enabled,
    why,
    fields,
    ondone,
  }: {
    ticketId: string;
    userId: number;
    /** The form action on the list page, without the `?/`. */
    action: string;
    label: string;
    confirmText: string;
    doneLabel: string;
    enabled: boolean;
    why: string;
    /** Further hidden fields the action reads, such as the id of the row it acts on. */
    fields?: Record<string, string | number>;
    ondone: (what: string, data: Record<string, unknown> | undefined) => void;
  } = $props();

  let confirming = $state(false);

  const form = new FormState({
    onSuccess: (data) => ondone(doneLabel, data),
    onSettled: () => (confirming = false),
  });
  const reason = $derived(enabled ? undefined : why);
</script>

<form method="POST" action="?/{action}" use:enhance={form.enhance} class="flex flex-col gap-1.5">
  <input type="hidden" name="ticketId" value={ticketId} />
  <input type="hidden" name="userId" value={userId} />
  {#each Object.entries(fields ?? {}) as [name, value] (name)}
    <input type="hidden" {name} {value} />
  {/each}
  <!-- The confirm button is the only real submit; it must not unmount itself in its own click
       handler (the submit would never fire) — `confirming` closes from `onSettled` instead. -->
  {#if confirming}
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="w-full text-xs text-red-300">{confirmText}</span>
      <Button type="submit" size="sm" disabled={form.submitting} data-touch-target>
        Yes, {label.toLowerCase()}
      </Button>
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
      disabled={!enabled || form.submitting}
      title={reason}
      onclick={() => (confirming = true)}
      data-touch-target
    >
      {label}…
    </Button>
  {/if}
  {#if form.error}<p class="m-0 text-xs text-red-300">{form.error}</p>{/if}
  {#if form.warning}<p class="m-0 text-xs text-amber-300">{form.warning}</p>{/if}
  {#if reason}<p class="m-0 text-[11px] text-amber-300">{reason}</p>{/if}
</form>
