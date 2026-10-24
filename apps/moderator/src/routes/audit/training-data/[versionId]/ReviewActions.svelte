<script lang="ts">
  import { enhance } from '$app/forms';
  import { afterNavigate, goto } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';
  import CsamReportForm from './CsamReportForm.svelte';

  let {
    modelHref,
    csamContents,
    canReportCsam,
  }: {
    modelHref: string;
    csamContents: Record<string, string>;
    canReportCsam: boolean;
  } = $props();

  // Held here rather than on the page so `{#key versionId}` around this component clears it: an open,
  // half-ticked CSAM report must not survive a navigation onto a different version.
  let reporting = $state(false);

  // A ruled-on version leaves the Paused queue, so there is nothing left here to look at. Going BACK
  // rather than to a computed URL keeps the page and scroll position the moderator was working from —
  // and the server could not compute it anyway, since `?/approve` replaces the page's own query string.
  //
  // `nav.from` is null when this page was loaded directly rather than navigated to (a pasted link, a
  // refresh): there is then no queue entry behind us, and going back would leave the app.
  let arrivedFrom = $state<URL | null>(null);
  afterNavigate((nav) => (arrivedFrom = nav.from?.url ?? null));

  const leave = () => (arrivedFrom ? history.back() : goto('/audit/training-data'));

  // One FormState for all three verdicts: they share a destination and a place to put a refusal, and
  // only one can be in flight at a time. `reload` stays off — a ruling navigates away, so re-running
  // this page's load would query a version we are leaving.
  //
  // The verdict is read off the action at submit time; by `onSuccess` we have navigated and there is
  // nothing left to ask.
  const VERDICTS: Record<string, string> = {
    '?/approve': 'Training data approved',
    '?/deny': 'Training data denied',
    '?/reportCsam': 'CSAM report filed',
  };
  let verdict = $state('');
  const form = new FormState({
    onSubmit: ({ action }) => (verdict = VERDICTS[action.search] ?? ''),
    onSuccess: (data) => {
      const warning = (data as { warning?: unknown } | undefined)?.warning;
      if (typeof warning === 'string') toast.error(warning, { duration: Infinity });
      else if (verdict) toast.success(verdict);
      leave();
    },
  });
</script>

<div class="mb-4 flex flex-wrap items-center gap-2">
  <form method="POST" action="?/approve" use:enhance={form.enhance}>
    <Button type="submit" size="sm" disabled={form.submitting}>Approve</Button>
  </form>
  <form method="POST" action="?/deny" use:enhance={form.enhance}>
    <Button type="submit" size="sm" variant="destructive" disabled={form.submitting}>Deny</Button>
  </form>
  {#if canReportCsam}
    <Button size="sm" variant="outline" onclick={() => (reporting = !reporting)}>Report CSAM</Button>
  {/if}
  <a href={modelHref} target="_blank" rel="noreferrer" class={LINK_CLASS}>Open model ↗</a>
</div>

{#if form.error}
  <p class="mb-4 text-sm text-red-300">{form.error}</p>
{/if}

{#if reporting && canReportCsam}
  <div class="mb-5">
    <CsamReportForm
      contents={csamContents}
      enhancer={form.enhance}
      busy={form.submitting}
      onCancel={() => (reporting = false)}
    />
  </div>
{/if}
