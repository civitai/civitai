<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { VIOLATION_TYPES, VIOLATION_LABELS } from '$lib/violations';

  let {
    action,
    submit,
    hidden,
    label = 'Delete',
    size = 'sm',
  }: {
    action: string;
    submit: SubmitFunction;
    /** Posted alongside the reason — `imageId`/`reportId` per card, `imageIds`/`reportIds` in bulk. */
    hidden: Record<string, string | number>;
    label?: string;
    size?: 'sm' | 'default';
  } = $props();

  let open = $state(false);
  let violationType = $state('');

  // The popover must NOT close in the submit button's own click handler: the content is portaled, so
  // tearing it down there disconnects the form before the browser runs its activation behaviour and
  // the submit silently never fires. Same defect as ConfirmSubmit.svelte's, which carries the same
  // note. Closing from the enhance callback is immune.
  const close: SubmitFunction = async (input) => {
    const callback = await submit(input);
    return async (opts) => {
      await callback?.(opts);
      open = false;
      violationType = '';
    };
  };
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline" {size} class="text-red-400 hover:text-red-300">
        {label}
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content align="end" class="w-72">
    <form method="POST" {action} use:enhance={close} class="flex flex-col gap-2">
      {#each Object.entries(hidden) as [name, value] (name)}
        <input type="hidden" {name} {value} />
      {/each}
      <label class="text-xs font-semibold uppercase text-dark-2" for="violation-{action}">
        Reason for removal
      </label>
      <!-- Explicit hidden input rather than `Select.Root name=`, matching ImageActionBar: an unset
           reason must post NOTHING, and the primitive would post an empty string. -->
      {#if violationType}
        <input type="hidden" name="violationType" value={violationType} />
      {/if}
      <Select.Root type="single" bind:value={violationType}>
        <Select.Trigger id="violation-{action}" class="w-full">
          {violationType ? VIOLATION_LABELS[violationType as keyof typeof VIOLATION_LABELS] : 'Unspecified'}
        </Select.Trigger>
        <Select.Content>
          {#each VIOLATION_TYPES as v (v)}
            <Select.Item value={v}>{VIOLATION_LABELS[v]}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Textarea
        name="violationDetails"
        rows={2}
        maxlength={1000}
        placeholder="Details (optional)"
        aria-label="Removal details"
      />
      <Button type="submit" variant="destructive" size="sm">{label}</Button>
    </form>
  </Popover.Content>
</Popover.Root>
