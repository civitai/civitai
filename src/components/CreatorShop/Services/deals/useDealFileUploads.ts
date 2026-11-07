import { useRef, useState } from 'react';
import { showErrorNotification } from '~/utils/notifications';

type Begin = (file: File, mimeType: string) => Promise<{ fileId: number; uploadUrl: string }>;

/**
 * Sends picked files one at a time: ask the server for an upload URL, PUT the bytes, then ask the
 * server to check them. `busy` names the files in flight. A failure is shown and the next file
 * still goes; `refresh` runs after each file either way.
 */
export function useDealFileUploads({
  verb,
  complete,
  refresh,
}: {
  /** "upload" or "attach", for the error title. */
  verb: string;
  complete: (fileId: number) => Promise<unknown>;
  refresh: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<{ key: number; name: string }[]>([]);
  const nextKey = useRef(0);

  const send = async (files: File[], begin: Begin) => {
    for (const file of files) {
      const key = nextKey.current++;
      setBusy((items) => [...items, { key, name: file.name }]);
      try {
        const mimeType = file.type || 'application/octet-stream';
        const { fileId, uploadUrl } = await begin(file, mimeType);
        const put = await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': mimeType },
        });
        if (!put.ok) throw new Error('The upload did not go through. Try again.');
        await complete(fileId);
      } catch (error) {
        showErrorNotification({
          title: `Couldn't ${verb} ${file.name}`,
          error: error instanceof Error ? error : { message: String(error) },
        });
      } finally {
        setBusy((items) => items.filter((item) => item.key !== key));
        await refresh();
      }
    }
  };

  return { busy, send };
}
