/** What a `ModelPreview` file row offers. A purged file has no bytes, so it shows a label in place of
 *  its visibility badge and offers no View or download. */
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
