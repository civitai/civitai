<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Collapsible from '@civitai/ui/components/ui/collapsible/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import type {
    AnnouncementColor,
    TrainingAnnouncement,
  } from '$lib/server/training-moderation.service';

  let {
    announcement,
    colors,
  }: {
    announcement: TrainingAnnouncement | null;
    colors: readonly AnnouncementColor[];
  } = $props();

  // What each colour MEANS on the training page, as the main app's picker spelled it out.
  const COLOR_LABEL: Record<string, string> = {
    yellow: 'Warning (Yellow)',
    red: 'Error (Red)',
    blue: 'Info (Blue)',
    green: 'Success (Green)',
    gray: 'Neutral (Gray)',
  };

  const DEFAULT_TEXT = `Due to high load, LoRA Trainings are not always successful - they may fail or get stuck in processing. Not to worry though, if your LoRA training fails your Buzz will be refunded within 24 hours. If your training has been processing for more than 24 hours it will be auto failed and a refund will be issued to you. If your training fails it's recommended that you try again.`;

  let open = $state(false);

  // `null` means "whatever is saved"; anything else is an unsaved edit. Derived rather than mirrored
  // through an $effect: every card on this page writes with `reload: true`, so the prop object gets a
  // new identity on each one, and a mirror would wipe the operator's half-typed banner when they
  // blocked publish on an unrelated model.
  let draftMessage = $state<string | null>(null);
  let draftColor = $state<string | null>(null);
  const message = $derived(draftMessage ?? announcement?.message ?? '');
  const color = $derived(draftColor ?? announcement?.color ?? 'yellow');
  // Save is pointless until something changed, and an always-live button invites a redundant write.
  const dirty = $derived(draftMessage !== null || draftColor !== null);

  const save = new FormState({
    reload: true,
    // Only a landed save may discard the draft.
    onSuccess: () => {
      draftMessage = null;
      draftColor = null;
      toast.success('Training announcement updated');
    },
  });
</script>

<section class="mb-5 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <Collapsible.Root bind:open>
    <Collapsible.Trigger class="flex w-full items-center justify-between text-left">
      <span class="text-sm font-semibold text-white">Training page announcement</span>
      <span class="text-xs text-dark-2">{open ? 'Hide' : 'Edit'}</span>
    </Collapsible.Trigger>

  {#if !open && announcement?.message}
    <p class="mt-2 line-clamp-2 text-sm text-dark-2">{announcement.message}</p>
  {/if}

    <Collapsible.Content>
    <form method="POST" action="?/saveAnnouncement" use:enhance={save.enhance} class="mt-4">
      <p class="mb-2 text-xs text-dark-2">
        Shown in the alert box on the training page. Markdown is supported. Saving an empty message
        clears it.
      </p>
      <Textarea
        name="message"
        bind:value={() => message, (v) => (draftMessage = v)}
        rows={4}
      />

      <div class="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <Label for="announcement-color" class="text-xs text-dark-2">Alert colour</Label>
          <Select.Root
            type="single"
            name="color"
            bind:value={() => color, (v) => (draftColor = v ?? 'yellow')}
          >
            <Select.Trigger id="announcement-color" class="mt-1 w-40">{COLOR_LABEL[color] ?? color}</Select.Trigger>
            <Select.Content>
              {#each colors as c (c)}
                <Select.Item value={c}>{COLOR_LABEL[c]}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>

        <Button type="submit" size="sm" disabled={save.submitting || !dirty}>
          {save.submitting ? 'Saving…' : message.trim() ? 'Save announcement' : 'Clear announcement'}
        </Button>
        <Button type="button" size="sm" variant="outline" onclick={() => (draftMessage = DEFAULT_TEXT)}>
          Reset to default
        </Button>
        <Button type="button" size="sm" variant="outline" onclick={() => (draftMessage = '')}>
          Clear
        </Button>
      </div>

      {#if save.error}
        <p class="mt-2 text-sm text-red-300">{save.error}</p>
      {/if}
    </form>
    </Collapsible.Content>
  </Collapsible.Root>
</section>
