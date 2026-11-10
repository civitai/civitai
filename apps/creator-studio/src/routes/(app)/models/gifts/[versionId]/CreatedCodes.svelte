<script lang="ts">
  import * as Alert from '@civitai/ui/components/ui/alert/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { codesCsv } from '../gift-links';

  let { codes, giftBase, ondismiss }: { codes: string[]; giftBase: string; ondismiss: () => void } =
    $props();

  const single = $derived(codes.length === 1);
  const links = $derived(codes.map((code) => `${giftBase}${code}`).join('\n'));

  async function copy() {
    try {
      await navigator.clipboard.writeText(links);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed. Select the text and copy it by hand.');
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([codesCsv(codes, giftBase)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gift-links.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<Alert.Root>
  <Alert.Title>{single ? 'Your gift link' : `${codes.length} single-use gift links`}</Alert.Title>
  <Alert.Description>
    <p>
      Copy {single ? 'it' : 'them'} now. Civitai stores only a fingerprint, so you can't see
      {single ? 'this link' : 'these links'} again after you dismiss this.
    </p>
    <Textarea readonly rows={single ? 1 : 6} class="mt-3 font-mono text-xs" value={links} />
    <div class="mt-3 flex gap-2">
      <Button size="sm" onclick={copy}>Copy</Button>
      {#if !single}
        <Button size="sm" variant="outline" onclick={download}>Download CSV</Button>
      {/if}
      <Button size="sm" variant="ghost" onclick={ondismiss}>Dismiss</Button>
    </div>
  </Alert.Description>
</Alert.Root>
