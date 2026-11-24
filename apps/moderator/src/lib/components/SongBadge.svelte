<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';

  // Marks a song wherever a moderator view lists one beside images and videos.
  let { class: className }: { class?: string } = $props();
</script>

<Badge class={cn('border-transparent bg-sky-600 text-white', className)}>Song</Badge>
