<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { IconDownload } from '@tabler/icons-svelte';
  import { bytes } from '$lib/format';
  import { previewFileControl } from '$lib/model-preview-file';
  import type { ModelPreviewFile } from '$lib/server/model-preview.service';

  /** One file of a version in `ModelPreview`. */
  let {
    file,
    versionId,
    civitaiUrl,
    canViewTrainingData,
    onview,
  }: {
    file: ModelPreviewFile;
    versionId: number;
    civitaiUrl: string;
    canViewTrainingData: boolean;
    onview: () => void;
  } = $props();

  const control = $derived(previewFileControl(file));

  // Clean files say nothing: a column of "Success" badges would bury the one that is not. A purged
  // file keeps only a Danger result; "not scanned yet" on bytes that are gone would read as pending.
  const flagged = $derived.by(() => {
    if (file.pickleScan === 'Danger' || file.virusScan === 'Danger')
      return {
        label: file.virusScan === 'Danger' ? 'Virus detected' : 'Unsafe pickle',
        class: 'border-red-500/40 bg-red-500/15 text-red-300',
      };
    if (file.purged) return null;
    const amber = 'border-amber-500/40 bg-amber-500/10 text-amber-300';
    if (file.pickleScan === 'Error' || file.virusScan === 'Error')
      return { label: 'Scan failed', class: amber };
    if (file.pickleScan !== 'Success' || file.virusScan !== 'Success')
      return { label: 'Not scanned yet', class: amber };
    return null;
  });
</script>

<li class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
  <span class="min-w-0 flex-1 truncate font-mono" title={file.name}>{file.name}</span>
  <span class="text-muted-foreground">
    {file.type}{file.format ? ` · ${file.format}` : ''} · {bytes(file.sizeKB)}
  </span>
  {#if control.kind === 'purged'}
    <Badge variant="outline">{control.label}</Badge>
  {:else if file.visibility !== 'Public'}
    <Badge variant="outline">{file.visibility}</Badge>
  {/if}
  {#if flagged}<Badge class={flagged.class}>{flagged.label}</Badge>{/if}
  {#if control.kind === 'view'}
    {#if canViewTrainingData}
      <Button type="button" size="sm" variant="outline" class="h-6 px-2 text-xs" onclick={onview}>
        View
      </Button>
    {/if}
  {:else if control.kind === 'download'}
    <!-- The site's own download route, by file id, on the moderator's civitai.com
         session — so the file they get is the one listed, scan state and all. -->
    <a
      href={`${civitaiUrl}/api/download/models/${versionId}?fileId=${file.id}`}
      class="link inline-flex items-center"
      aria-label={`Download ${file.name}`}
      title="Download from Civitai"
    >
      <IconDownload size={14} />
    </a>
  {/if}
</li>
