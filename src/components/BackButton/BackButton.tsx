import { useHasClientHistory } from '~/store/ClientHistoryStore';
import { useRef, useEffect } from 'react';
import { useRouter } from 'next/router';
import { UrlObject } from 'url';
import { ActionIcon, Group } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons';

export function NavigateBack({
  url,
  as,
  options = {},
  children,
}: {
  url: UrlObject | string;
  as?: UrlObject | string;
  options?: { replace?: boolean; shallow?: boolean };
  children: ({ onClick }: { onClick: (e: React.MouseEvent) => void }) => React.ReactElement;
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

  return children({ onClick: handleClick });
}

export function BackButton({
  url,
  as,
  options = {},
  children,
}: {
  url: UrlObject | string;
  as?: UrlObject | string;
  options?: { replace?: boolean; shallow?: boolean };
  children?: React.ReactNode;
}) {
  return (
    <NavigateBack url={url} as={as} options={options}>
      {({ onClick }) => (
        <Group spacing="xs">
          <ActionIcon onClick={onClick}>
            <IconArrowLeft />
          </ActionIcon>
          {children}
        </Group>
      )}
    </NavigateBack>
  );
}
