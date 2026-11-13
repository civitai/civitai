<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { IconSparkles } from '@tabler/icons-svelte';
  import { FormState } from '$lib/form-state.svelte';

  // Opens a mod assistant chat about this account (and report). Rendered only for a moderator who can
  // open `/assistant` and run it; the action checks the grant again. The action lives on another
  // route, so a refusal is shown here: SvelteKit's default handling would drop it.
  let { userId, reportId = null }: { userId: number; reportId?: number | null } = $props();

  const start = new FormState({ onSuccess: null });
</script>

<form method="POST" action="/assistant?/start" use:enhance={start.enhance} class="inline">
  <input type="hidden" name="userId" value={userId} />
  {#if reportId}<input type="hidden" name="reportId" value={reportId} />{/if}
  <Button type="submit" size="xs" variant="outline" disabled={start.submitting}>
    <IconSparkles size={14} />
    Investigate
  </Button>
  {#if start.error}<span class="ml-2 text-xs text-red-300" role="alert">{start.error}</span>{/if}
</form>
