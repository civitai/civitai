import React from 'react';
import { EdgeUrlProps, useGetEdgeUrl } from '~/client-utils/cf-images-utils';

export function DownloadImage({
  children,
  src,
  ...options
}: EdgeUrlProps & { children: ({ onClick }: { onClick: () => void }) => React.ReactElement }) {
  const url = useGetEdgeUrl(src, options);

  async function onClick() {
    const a = document.createElement('a');
    a.href = `${url}?disposition=attachment`;
    a.download = options.name ?? (url.split('/').pop() as string);
    a.target = '_parent ';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return children({ onClick });
}
