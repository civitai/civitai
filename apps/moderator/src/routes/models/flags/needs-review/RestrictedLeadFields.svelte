<script lang="ts">
  /** The lead a ruling is for: the model, and the lead as the screen showed it, which the main app
   *  compares before it rules. Shared by every ruling form on a lead. */
  let { modelId, revision }: { modelId: number; revision: string } = $props();
</script>

<input type="hidden" name="modelId" value={modelId} />
<input type="hidden" name="revision" value={revision} />
