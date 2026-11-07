<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { codesCsv } from './gift-links';

  let { codes, giftBase }: { codes: string[]; giftBase: string } = $props();

  const single = $derived(codes.length === 1);
  const text = $derived(single ? `${giftBase}${codes[0]}` : codes.join('\n'));

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed. Select the text and copy it by hand.');
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([codesCsv(codes)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gift-codes.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<div class="rounded-xl border border-yellow-5/40 bg-yellow-5/10 p-5">
  <p class="text-sm font-medium text-white">
    {single ? 'Your gift link' : `${codes.length} single-use codes`}
  </p>
  <p class="mt-1 text-sm text-dark-2">
    Copy {single ? 'it' : 'them'} now. Civitai stores only a fingerprint, so you won't see {single
      ? 'this link'
      : 'these codes'} again.
  </p>
  <textarea
    readonly
    rows={single ? 1 : 6}
    class="mt-3 w-full rounded-md border border-dark-4 bg-dark-7 p-2 font-mono text-xs text-dark-0"
    >{text}</textarea
  >
  <div class="mt-3 flex gap-2">
    <Button size="sm" onclick={copy}>Copy</Button>
    {#if !single}
      <Button size="sm" variant="outline" onclick={download}>Download CSV</Button>
    {/if}
  </div>
</div>
