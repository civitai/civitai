import React, { useState } from 'react';
import { EdgeUrlProps, useEdgeUrl } from '~/client-utils/cf-images-utils';

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
      a.download = options.name ?? (url.split('/').pop() as string);
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
