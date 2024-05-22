import React, { useState } from 'react';
import { EdgeUrlProps, useGetEdgeUrl } from '~/client-utils/cf-images-utils';
import { fetchBlob } from '~/utils/file-utils';

export function DownloadImage({
  children,
  src,
  ...options
}: EdgeUrlProps & {
  children: (props: { onClick: () => void; isLoading: boolean }) => React.ReactElement;
}) {
  const url = useGetEdgeUrl(src, options);
  const [loading, setLoading] = useState(false);

  async function onClick() {
    try {
      setLoading(true);
      const blob = await fetchBlob(url);
      if (blob) {
        const a = document.createElement('a');
        const href = URL.createObjectURL(blob);
        a.href = href;
        a.download = options.name ?? (url.split('/').pop() as string);
        a.target = '_parent ';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(href);
      }
    } catch {}
    setLoading(false);
    // const a = document.createElement('a');
    // a.href = `${url}?disposition=attachment`;
    // a.download = options.name ?? (url.split('/').pop() as string);
    // a.target = '_parent ';
    // document.body.appendChild(a);
    // a.click();
    // document.body.removeChild(a);
  }

  return children({ onClick, isLoading: loading });
}
