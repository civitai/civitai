import { describe, expect, it } from 'vitest';
import { previewFileControl } from '../model-preview-file';

describe('previewFileControl', () => {
  it('says a purged dataset was removed and offers nothing to open', () => {
    expect(previewFileControl({ type: 'Training Data', purged: true })).toEqual({
      kind: 'purged',
      label: 'Training data removed (purged)',
    });
  });

  it('offers View on live training data and a download on every other live file', () => {
    expect(previewFileControl({ type: 'Training Data', purged: false })).toEqual({ kind: 'view' });
    expect(previewFileControl({ type: 'Model', purged: false })).toEqual({ kind: 'download' });
  });
});
