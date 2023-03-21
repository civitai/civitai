import { useHasClientHistory } from '~/store/ClientHistoryStore';
import { useRef, useEffect } from 'react';
import { useRouter } from 'next/router';
import { UrlObject } from 'url';
import { ActionIcon } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons';

export function BackButton({
  url,
  as,
  options = {},
}: {
  url: UrlObject | string;
  as?: UrlObject | string;
  options?: { replace?: boolean; shallow?: boolean };
}) {
  const router = useRouter();
  const closingRef = useRef(false);
  const hasHistory = useHasClientHistory();

  useEffect(() => {
    closingRef.current = false;
  }, [router]);

  const handleClick = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (hasHistory) router.back();
    else {
      const navigate = options.replace ? router.replace : router.push;
      navigate(url, as, options);
    }
  };

  return (
    <ActionIcon onClick={handleClick}>
      <IconArrowLeft />
    </ActionIcon>
  );
}
