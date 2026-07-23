<script lang="ts">
  import '../global.css';

  // Bare layout for the public landing; the authed sidebar shell lives in (app)/+layout.svelte.
  let { children }: { children: import('svelte').Snippet } = $props();
</script>

{@render children()}
