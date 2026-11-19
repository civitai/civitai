/** What a file row in `ModelPreview` offers. A purged file keeps its row, the record that it existed,
 *  but its bytes are gone, so it offers nothing to open and says so instead of showing its visibility. */
export type PreviewFileControl =
  | { kind: 'purged'; label: string }
  | { kind: 'view' }
  | { kind: 'download' };

export function previewFileControl(file: { type: string; purged: boolean }): PreviewFileControl {
  const training = file.type === 'Training Data';
  if (file.purged)
    return {
      kind: 'purged',
      label: training ? 'Training data removed (purged)' : 'File removed (purged)',
    };
  return training ? { kind: 'view' } : { kind: 'download' };
}
