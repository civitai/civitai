<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Card from '@civitai/ui/components/ui/card/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';

  let { on }: { on: boolean } = $props();
  let submitting = $state(false);
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
      method="POST"
      action="?/tagReview"
      class="flex items-center justify-between gap-4"
      use:enhance={() => {
        submitting = true;
        return async ({ result, update }) => {
          submitting = false;
          if (result.type === 'failure')
            toast.error(String(result.data?.error ?? 'The switch could not be saved.'));
          await update();
        };
      }}
    >
      <p class="text-sm text-dark-0">{on ? 'On' : 'Off'}</p>
      <input type="hidden" name="modTagReview" value={on ? 'off' : 'on'} />
      <Button type="submit" variant="outline" size="sm" disabled={submitting}>
        {on ? 'Turn off' : 'Turn on'}
      </Button>
    </form>
  </Card.Content>
</Card.Root>
