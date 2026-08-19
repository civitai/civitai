<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';

  let { href }: { href: string | null } = $props();
</script>

{#if href}
  <div class="mt-5 flex justify-center">
    <Button variant="outline" {href}>Next →</Button>
  </div>
{/if}
