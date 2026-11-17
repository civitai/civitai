import { describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as Notifications from '~/utils/notifications';
import { chooseFiles } from '../../../../test/unreadable-files';

const mocks = vi.hoisted(() => ({ showErrorNotification: vi.fn() }));
vi.mock('~/utils/notifications', async (orig) => ({
  ...(await orig<typeof Notifications>()),
  showErrorNotification: mocks.showErrorNotification,
}));

// eslint-disable-next-line import/first
import { constants } from '~/server/common/constants';
// eslint-disable-next-line import/first
import { MediaDropzone } from '~/components/Image/ImageDropzone/MediaDropzone';
// eslint-disable-next-line import/first
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';

describe('MediaDropzone — a file it does not accept', () => {
  test('says which formats and limits it takes, and does not hand the file on', async () => {
    const onDrop = vi.fn();
    const onReject = vi.fn();
    renderWithProviders(
      <div data-testid="media">
        <MediaDropzone
          onDrop={onDrop}
          onReject={onReject}
          accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
        />
      </div>
    );
    const input = await vi.waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('[data-testid="media"] input[type=file]');
      if (!el) throw new Error('dropzone input not found');
      return el;
    });
    await chooseFiles(input, [
      new File([new Uint8Array([1])], 'holiday.mov', { type: 'video/quicktime' }),
    ]);

    await vi.waitFor(() => expect(mocks.showErrorNotification).toHaveBeenCalledTimes(1));
    const { error } = mocks.showErrorNotification.mock.calls[0][0];
    const { maxVideoDurationSeconds, maxVideoDimension } = constants.mediaUpload;
    expect(error.message).toContain('holiday.mov: unsupported file type');
    expect(error.message).toContain('.mp4, .webm');
    expect(error.message).toContain(`${maxVideoDurationSeconds} seconds, ${maxVideoDimension}px`);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});
