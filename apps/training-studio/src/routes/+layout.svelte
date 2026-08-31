<script lang="ts">
  import '../global.css';

  let { children }: { children: import('svelte').Snippet } = $props();
</script>

<div class="mx-auto w-full max-w-6xl overflow-x-hidden px-6 py-10">
  {@render children()}
</div>
