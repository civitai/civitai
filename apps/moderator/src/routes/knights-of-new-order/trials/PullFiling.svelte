<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS } from '$lib/format';
  import { ReportEntity, reportActionPath, reportStatusVariant } from '$lib/reports';

  /** The main-app report Knights filed (or did not need to) for an image pull. */
  let {
    pull,
  }: { pull: { reportId: number | null; reportStatus: string | null; filing: string } } = $props();
</script>

{#if pull.reportId}
  <a href={reportActionPath(ReportEntity.Image, pull.reportId)} class={LINK_CLASS}>Image report #{pull.reportId}</a>
  {#if pull.reportStatus}
    <Badge variant={reportStatusVariant(pull.reportStatus)}>{pull.reportStatus}</Badge>
  {/if}
{:else if pull.filing === 'not-needed'}
  <span>No image report: the main app no longer has the image.</span>
{:else}
  <span>Its image report is not filed yet; Knights retries it.</span>
{/if}
