import { useEffect, useRef, useState } from 'react';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants } from '~/server/common/constants';
import type { SongCover } from '~/server/services/post.service';
import { formatBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export const SONG_COVER_ACCEPT = 'image/png,image/jpeg,image/webp';

const UPLOAD_FAILED = "The cover didn't upload. Check your connection and try again.";
const SAVE_FAILED = "The cover uploaded but couldn't be saved. Try again.";

export type SongCoverUploadState =
  | { status: 'idle' }
  | { status: 'uploading'; progress: number }
  | { status: 'saving' }
  | { status: 'error'; message: string; canRetry: boolean };

type Uploaded = { url: string; width: number; height: number; hash?: string; mimeType?: string };
type Phase = Exclude<SongCoverUploadState, { status: 'uploading' }> | { status: 'uploading' };

/** Uploads a picked image and makes it the song's cover, keeping a local preview until it shows. */
export function useSongCoverUpload({
  songId,
  onSaved,
}: {
  songId: number;
  onSaved: (cover: SongCover) => void;
}) {
  const { uploadToCF, files, resetFiles } = useCFImageUpload();
  const { mutateAsync } = trpc.image.setSongCover.useMutation();
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const picked = useRef<File>();
  const uploaded = useRef<Uploaded>();
  const tracked = files[0];
  const preview = tracked?.objectUrl;

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview]
  );

  const save = async () => {
    if (!uploaded.current) return;
    setPhase({ status: 'saving' });
    try {
      const cover = await mutateAsync({
        id: songId,
        cover: { ...uploaded.current, type: 'image' },
      });
      setPhase({ status: 'idle' });
      onSaved(cover);
    } catch {
      setPhase({ status: 'error', message: SAVE_FAILED, canRetry: true });
    }
  };

  // The upload hook reports the outcome through its tracked file, not through the promise.
  useEffect(() => {
    if (phase.status !== 'uploading' || !tracked) return;
    if (tracked.status === 'success') {
      const { url, width, height, hash, mimeType } = tracked;
      uploaded.current = { url, width, height, hash, mimeType };
      void save();
    } else if (tracked.status === 'error' || tracked.status === 'aborted') {
      setPhase({ status: 'error', message: UPLOAD_FAILED, canRetry: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.status, tracked?.status]);

  const upload = async (file: File) => {
    uploaded.current = undefined;
    resetFiles();
    setPhase({ status: 'uploading' });
    try {
      await uploadToCF(file);
    } catch {
      setPhase({ status: 'error', message: UPLOAD_FAILED, canRetry: true });
    }
  };

  const busy = phase.status === 'uploading' || phase.status === 'saving';

  const pick = (file: File | null) => {
    if (!file || busy) return;
    const maxSize = constants.mediaUpload.maxImageFileSize;
    if (!file.type.startsWith('image/'))
      return setPhase({ status: 'error', message: 'Choose an image file.', canRetry: false });
    if (file.size > maxSize)
      return setPhase({
        status: 'error',
        message: `Images should not exceed ${formatBytes(maxSize)}`,
        canRetry: false,
      });
    picked.current = file;
    void upload(file);
  };

  const retry = () => {
    if (busy) return;
    if (uploaded.current) void save();
    else if (picked.current) void upload(picked.current);
  };

  const state: SongCoverUploadState =
    phase.status === 'uploading'
      ? { status: 'uploading', progress: Math.round(tracked?.progress ?? 0) }
      : phase;

  return { state, busy, preview, pick, retry };
}
