<script lang="ts">
  import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
  } from '@civitai/ui/components/ui/sheet/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import TrainingAssetViewer from '$lib/components/TrainingAssetViewer.svelte';

  let {
    open = $bindable(false),
    versionId,
    title,
    badges = [],
  }: {
    open?: boolean;
    versionId: number;
    title: string;
    badges?: string[];
  } = $props();
</script>

<Sheet bind:open>
  <SheetContent side="right" class="w-[92vw] overflow-y-auto sm:max-w-[72rem]">
    <SheetHeader>
      <SheetTitle>{title}</SheetTitle>
    </SheetHeader>
    <div class="p-4">
      {#if badges.length}
        <div class="mb-3 flex flex-wrap gap-2">
          {#each badges as badge, i (`${i}:${badge}`)}
            <Badge variant="outline">{badge}</Badge>
          {/each}
        </div>
      {/if}

      <!-- `enabled` gates the download on the sheet being open, and closing it aborts the run. -->
      <TrainingAssetViewer {versionId} enabled={open} />
    </div>
  </SheetContent>
</Sheet>
