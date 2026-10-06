<script lang="ts">
  import { LINK_CLASS } from '$lib/format';
  import { csamExternalReportUrl, userLookupUrl } from '$lib/entity-url';

  let {
    civitaiUrl,
    ownerId,
    workflowId,
  }: { civitaiUrl: string; ownerId: number; workflowId: string } = $props();
</script>

<!-- Deny first so the run cannot proceed while the report is filed. -->
<section
  class="mb-5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
  data-testid="workflow-csam-guidance"
>
  <p>
    CSAM in this dataset: <strong>deny</strong> the run, then file an
    <a href={csamExternalReportUrl(civitaiUrl)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
      external report on the main site ↗
    </a>
    for the run's owner. Enter the owner's user id and email (from their
    <a href={userLookupUrl(ownerId)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
      user lookup ↗
    </a>), and put the workflow id in
    its additional notes.
  </p>
  <dl class="my-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
    <dt class="text-xs text-dark-2">Owner user id</dt>
    <dd><code class="select-all text-dark-0">{ownerId}</code></dd>
    <dt class="text-xs text-dark-2">Workflow id</dt>
    <dd><code class="select-all break-all text-dark-0">{workflowId}</code></dd>
  </dl>
  <p>
    Do not use the account-level image report for this run: it reports images posted on the site,
    and cannot carry this run's dataset. The external report requires an email; if the owner has
    none on file, escalate the run rather than filing the account-level report.
  </p>
</section>
