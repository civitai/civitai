import { describe, expect, it } from 'vitest';
import { getModelVersionActionLayout } from './model-version-layout';

// A downloadable version with visible files — the inputs that decide the branch are varied per test.
const downloadable = {
  showRequestReview: false,
  showPublishButton: false,
  hideDownload: false,
  isComponentOnlyModel: false,
  hasVisibleFiles: true,
};

describe('getModelVersionActionLayout', () => {
  describe('branch selection', () => {
    it('prefers request-review over publish-pending when both apply', () => {
      const { branch } = getModelVersionActionLayout({
        ...downloadable,
        showRequestReview: true,
        showPublishButton: true,
      });

      expect(branch).toBe('request-review');
    });

    it('routes an owner-or-moderator on an unpublished version to publish-pending', () => {
      const { branch } = getModelVersionActionLayout({ ...downloadable, showPublishButton: true });

      expect(branch).toBe('publish-pending');
    });

    it('falls back to default when neither publish nor review applies', () => {
      const { branch } = getModelVersionActionLayout(downloadable);

      expect(branch).toBe('default');
    });
  });

  describe('download availability', () => {
    // The regression this module exists for: the download card used to live inside the `default`
    // branch's JSX, so routing to publish-pending (owner or moderator, unpublished, has files +
    // posts) removed every download control — including for a moderator reviewing a takedown, who
    // the server already answers with a signed URL.
    it('keeps the download section in the publish-pending branch', () => {
      const { branch, showDownloadSection } = getModelVersionActionLayout({
        ...downloadable,
        showPublishButton: true,
      });

      expect(branch).toBe('publish-pending');
      expect(showDownloadSection).toBe(true);
    });

    it('keeps the download section in the default branch', () => {
      expect(getModelVersionActionLayout(downloadable).showDownloadSection).toBe(true);
    });

    it('drops the download section in the request-review branch', () => {
      const { showDownloadSection } = getModelVersionActionLayout({
        ...downloadable,
        showRequestReview: true,
      });

      expect(showDownloadSection).toBe(false);
    });

    it.each([
      ['downloads are disabled for the version', { hideDownload: true }],
      ['the model is component-only', { isComponentOnlyModel: true }],
      ['there are no visible files', { hasVisibleFiles: false }],
    ])('hides the download section when %s, even while publish-pending', (_label, overrides) => {
      const { showDownloadSection } = getModelVersionActionLayout({
        ...downloadable,
        showPublishButton: true,
        ...overrides,
      });

      expect(showDownloadSection).toBe(false);
    });
  });
});
