<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';

  // A destructive submit that asks first, for bulk actions inside an existing form. Retool gated its
  // bulk review/comment deletion behind a modal; ban and purge got confirmations here and these did not,
  // so a mis-click deleted whatever happened to be ticked.
  //
  // The confirm button is the ONLY real submit — the first click is `type="button"` and posts nothing —
  // so the form cannot fire before the count has been read back to the operator.
  let {
    label,
    name,
    value,
    count,
    noun,
    submitting = false,
  }: {
    label: string;
    /** Form field the op is posted as, e.g. `op`. */
    name: string;
    value: string;
    /** How many rows are ticked. Zero disables the button — the action would be a no-op. */
    count: number;
    /** Singular; pluralised with a bare "s". */
    noun: string;
    submitting?: boolean;
  } = $props();

  let confirming = $state(false);

  // The confirm button must NOT clear `confirming` in its own click handler. Svelte flushes effects
  // synchronously after a DOM event handler, so doing that unmounts the submitter through the `{#if}`
  // before the browser runs the form's activation behaviour — the submit never fires and "Yes, delete"
  // behaves exactly like Cancel, silently. It is closed when the write finishes instead.
  let wasSubmitting = $state(false);
  $effect(() => {
    if (wasSubmitting && !submitting) confirming = false;
    wasSubmitting = submitting;
  });
</script>

{#if confirming}
  <span class="text-sm text-red-300">
    {label} {count} {noun}{count === 1 ? '' : 's'}?
  </span>
  <Button type="submit" {name} {value} size="sm" variant="destructive" disabled={submitting}>
    Yes, {label.toLowerCase()}
  </Button>
  <Button type="button" size="sm" variant="outline" onclick={() => (confirming = false)}>
    Cancel
  </Button>
{:else}
  <Button
    type="button"
    size="sm"
    variant="destructive"
    disabled={submitting || count === 0}
    onclick={() => (confirming = true)}
  >
    {label}
  </Button>
{/if}
