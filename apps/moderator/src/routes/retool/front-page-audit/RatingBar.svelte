<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { SWEEP_LEVELS } from './sweep';

  let {
    imageId,
    current,
    onSubmit,
    onRated,
  }: {
    imageId: number;
    current: number;
    onSubmit: SubmitFunction;
    /** `ok` is false when the action failed, so the caller can undo its optimistic state. */
    onRated: (level: number, ok: boolean) => void;
  } = $props();

  let busy = $state(false);
  let pending = $state<number | null>(null);
</script>

<form
  method="POST"
  action="?/setRating"
  use:enhance={(event) => {
    busy = true;
    pending = Number(event.formData.get('nsfwLevel'));
    if (pending) onRated(pending, true);
    const inner = onSubmit(event);
    return async (opts) => {
      if (typeof inner === 'function') await inner(opts);
      if (opts.result.type !== 'success' && pending) onRated(pending, false);
      pending = null;
      busy = false;
    };
  }}
  class="flex flex-wrap gap-1"
>
  <input type="hidden" name="imageId" value={imageId} />
  {#each SWEEP_LEVELS as level (level.value)}
    <Button
      type="submit"
      name="nsfwLevel"
      value={String(level.value)}
      size="sm"
      variant={level.value === current ? 'secondary' : 'outline'}
      disabled={busy || level.value === current}
    >
      {level.label}
    </Button>
  {/each}
</form>
