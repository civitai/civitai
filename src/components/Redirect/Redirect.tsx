import { useRouter } from 'next/router';
import { useEffect } from 'react';
import type { UrlObject } from 'url';

type Url = UrlObject | string;

export function Redirect({
  url,
  as,
  options,
}: {
  url: Url;
  as?: Url;
  options?: { shallow?: boolean };
}) {
  const router = useRouter();

  useEffect(() => {
    router.replace(url, as, options);
  }, []);

  return null;
}
