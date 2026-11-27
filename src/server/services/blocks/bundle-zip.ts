import JSZip from 'jszip';

/**
 * A bundle ZIP of `files` built deterministically: entries in path order (`localeCompare`) and
 * every timestamp zeroed (`date: new Date(0)`), so the same files always give the same bytes and
 * the same `bundleSha256`. Imports nothing from the services that use it.
 */
export async function deterministicBundleZip(
  files: Iterable<{ path: string; content: Buffer }>
): Promise<Buffer> {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const zip = new JSZip();
  for (const f of sorted) zip.file(f.path, f.content, { date: new Date(0) });
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
