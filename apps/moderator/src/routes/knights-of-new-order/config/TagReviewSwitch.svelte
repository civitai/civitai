<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import * as Card from '@civitai/ui/components/ui/card/index.js';
  import { Switch } from '@civitai/ui/components/ui/switch/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';

  let { on }: { on: boolean } = $props();

  // Held here after a save: reloading the page data would re-key the editor above and drop its unsaved draft.
  let checked = $state(untrack(() => on));
  let submitting = $state(false);
  let form: HTMLFormElement;
</script>

<Card.Root id="tag-review">
  <Card.Header>
    <Card.Title>Paladin tag review</Card.Title>
    <Card.Description class="text-dark-2">
      Paladins answer the image tag review queue as yes/no questions. A consensus keeps or removes
      the tag the way the queue's own buttons do; without one the tag stays with moderators. The
      queue itself does not change.
    </Card.Description>
  </Card.Header>
  <Card.Content>
    <form
      bind:this={form}
      method="POST"
      action="?/tagReview"
      class="flex items-center justify-between gap-4"
      use:enhance={() => {
        submitting = true;
        const wanted = checked;
        return async ({ result, update }) => {
          submitting = false;
          if (result.type === 'success') toast.success('Saved');
          else {
            checked = !wanted;
            toast.error(
              result.type === 'failure'
                ? String(result.data?.error ?? 'The switch could not be saved.')
                : 'The switch could not be saved. Try again.'
            );
          }
          // The error is shown here only: no other panel reads the page's form result.
          await update({ reset: false, invalidateAll: false });
        };
      }}
    >
      <label for="mod-tag-review" class="text-sm text-dark-0">
        {checked ? 'On' : 'Off'}
      </label>
      <input type="hidden" name="modTagReview" value={checked ? 'on' : 'off'} />
      <Switch
        id="mod-tag-review"
        bind:checked
        disabled={submitting}
        onCheckedChange={() => queueMicrotask(() => form.requestSubmit())}
      />
    </form>
  </Card.Content>
</Card.Root>
