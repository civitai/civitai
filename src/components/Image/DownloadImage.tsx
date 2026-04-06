import type React from 'react';
import { useState } from 'react';
import type { EdgeUrlProps } from '~/client-utils/cf-images-utils';
import { useEdgeUrl } from '~/client-utils/cf-images-utils';

export function DownloadImage({
  children,
  src,
  ...options
}: EdgeUrlProps & {
  children: (props: {
    onClick: () => void;
    isLoading: boolean;
    progress: number;
  }) => React.ReactElement;
}) {
  const { url } = useEdgeUrl(src, options);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  async function onClick() {
    if (!url) {
      console.error('missing url for DownloadImage component');
      return;
    }
    try {
      setLoading(true);
      const xhr = new XMLHttpRequest();
      xhr.responseType = 'blob';
      const blob = await new Promise<Blob>((resolve, reject) => {
        xhr.addEventListener('progress', ({ loaded, total }) => {
          setProgress((loaded / total) * 100);
        });
        xhr.addEventListener('loadend', () => {
          if (xhr.readyState === 4 && xhr.status === 200) resolve(xhr.response);
        });
        xhr.addEventListener('error', reject);
        xhr.open('GET', url);
        xhr.send();
      });

      const a = document.createElement('a');
      const href = URL.createObjectURL(blob);
      a.href = href;

      // Clean the filename by removing query parameters and fragments
      let cleanFilename = options.name ?? (url.split('/').pop() as string);
      cleanFilename = cleanFilename.split('?')[0].split('#')[0];

      // Handle cases where the extension appears multiple times due to token appending
      // e.g. "file.mp4.mp4" -> "file.mp4", but preserve dots in the base name
      // e.g. "video-ttget.com.mp4" should stay as "video-ttget.com.mp4"
      const extMatch = cleanFilename.match(/\.([a-zA-Z0-9]{2,5})$/);
      if (extMatch) {
        const ext = extMatch[1];
        // Strip trailing duplicate extensions (e.g. ".mp4.mp4" -> ".mp4")
        const dupePattern = new RegExp(`(\\.${ext})+$`);
        cleanFilename = cleanFilename.replace(dupePattern, `.${ext}`);
      }

      a.download = cleanFilename;
      a.target = '_blank ';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(href);
    } catch {}
    setTimeout(() => {
      setLoading(false);
      setProgress(0);
    }, 300);
    // const a = document.createElement('a');
    // a.href = `${url}?disposition=attachment`;
    // a.download = options.name ?? (url.split('/').pop() as string);
    // a.target = '_parent ';
    // document.body.appendChild(a);
    // a.click();
    // document.body.removeChild(a);
  }

  return children({ onClick, isLoading: loading, progress });
}
