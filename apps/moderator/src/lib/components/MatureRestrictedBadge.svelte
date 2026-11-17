<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';

  let { restricted, class: className = '' }: { restricted: boolean; class?: string } = $props();
</script>

<!-- `secondary`: a property of the image, not a verdict (see ImageFlagBadges). -->
{#if restricted}
  <Badge
    variant="secondary"
    class="w-fit {className}"
    title="Made with a base model that restricts mature images: rated R or above, it is hidden from feeds, galleries, covers and search. Its uploader still sees it where the page is built for them, and moderators can open it by id."
  >
    MatureRestricted
  </Badge>
{/if}
