<script lang="ts">
  import { RUN_STATE_BADGE, type RunState } from '$lib/data/trainingRows';

  let { state, class: className = '' }: { state: RunState; class?: string } = $props();
  const badge = $derived(RUN_STATE_BADGE[state]);
</script>

<span
  class="inline-flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1 text-xs font-semibold {badge.cls} {className}"
>
  <span class="h-1.5 w-1.5 rounded-full {badge.dot}"></span>{badge.label}
</span>
