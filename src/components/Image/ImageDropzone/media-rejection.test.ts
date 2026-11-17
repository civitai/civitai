import type { FileRejection } from '@mantine/dropzone';
import { describe, expect, it } from 'vitest';
import { describeMediaRejection } from '~/components/Image/ImageDropzone/media-rejection';

const rejection = (name: string, code: string, size = 1): FileRejection => ({
  file: new File([new Uint8Array(size)], name),
  errors: [{ code, message: code }],
});
const limits = { extensions: ['.mp4', '.webm'], maxSize: 2048, maxFiles: 3 };

describe('describeMediaRejection', () => {
  it('names the file and the accepted formats for a wrong type', () => {
    expect(describeMediaRejection([rejection('a.mov', 'file-invalid-type')], limits)).toBe(
      'a.mov: unsupported file type. Accepted: .mp4, .webm.'
    );
  });
  it('states the size and the limit for a file that is too large', () => {
    expect(describeMediaRejection([rejection('a.mp4', 'file-too-large', 4096)], limits)).toBe(
      'a.mp4 is 4 KB. The limit is 2 KB.'
    );
  });
  it('states the file count limit', () => {
    expect(describeMediaRejection([rejection('a.mp4', 'too-many-files')], limits)).toBe(
      'Too many files. Add up to 3 at a time.'
    );
  });
  it('counts the rest when several files were rejected', () => {
    expect(
      describeMediaRejection(
        [rejection('a.mov', 'file-invalid-type'), rejection('b.mkv', 'file-invalid-type')],
        limits
      )
    ).toMatch(/\(1 more not added\.\)$/);
  });
  it('says nothing when nothing was rejected', () => {
    expect(describeMediaRejection([], limits)).toBeUndefined();
  });
});
