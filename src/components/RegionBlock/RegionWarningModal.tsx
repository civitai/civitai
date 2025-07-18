import { Button, Group, Modal } from '@mantine/core';
import rehypeRaw from 'rehype-raw';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getRegionBlockDate, isRegionPendingBlock } from '~/server/utils/region-blocking';
import { useEffect, useMemo, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import { useIsRegionBlocked } from '~/hooks/useIsRegionBlocked';

export function RegionWarningModal() {
  const currentUser = useCurrentUser();
  const [isOpen, setIsOpen] = useState(false);
  const { isPendingBlock } = useIsRegionBlocked();

  // Generate content key based on region
  const contentKey = useMemo(() => {
    if (!currentUser?.region) return null;
    return currentUser.region.countryCode || 'unknown';
  }, [currentUser?.region]);

  // Fetch markdown content from Redis
  const { data: contentData } = trpc.content.getMarkdown.useQuery(
    { key: contentKey as string },
    { enabled: !!contentKey && isPendingBlock }
  );

  // Generate a storage key that includes the region and block date to ensure
  // users see the modal again if the date changes
  const storageKey = useMemo(() => {
    if (!currentUser?.region) return null;
    const regionCode = currentUser.region.countryCode || 'unknown';
    return `region-warning-dismissed-${regionCode}`;
  }, [currentUser?.region]);

  const warningInfo = useMemo(() => {
    if (!currentUser?.region || !contentData || !isPendingBlock) return null;

    const blockDate = getRegionBlockDate(currentUser.region);
    const currentDate = new Date();
    if (!blockDate || blockDate < currentDate) return null;

    return {
      title: contentData.title,
      content: contentData.content,
    };
  }, [currentUser?.region, contentData, isPendingBlock]);

  // Check if modal should be shown on mount
  useEffect(() => {
    if (warningInfo && storageKey) {
      const isDismissed = localStorage.getItem(storageKey) === 'true';
      if (!isDismissed) {
        setIsOpen(true);
      }
    }
  }, [warningInfo, storageKey]);

  const handleDismiss = () => {
    setIsOpen(false);
    if (storageKey) {
      localStorage.setItem(storageKey, 'true');
    }
  };

  if (!warningInfo) return null;

  const { title, content } = warningInfo;

  return (
    <Modal
      opened={isOpen}
      onClose={handleDismiss}
      title={`⚠️ ${title}`}
      classNames={{
        title: 'text-xl font-bold text-inherit',
        header: 'bg-red-5 text-white',
        close: 'text-inherit',
      }}
      size="xl"
      centered
    >
      <TypographyStylesWrapper>
        <CustomMarkdown
          rehypePlugins={[rehypeRaw]}
          remarkPlugins={[remarkBreaks, remarkGfm]}
          className="markdown-content-spaced"
        >
          {content}
        </CustomMarkdown>
      </TypographyStylesWrapper>
      <Group justify="flex-end" gap="sm" mt="lg">
        <Button variant="outline" onClick={handleDismiss}>
          Dismiss
        </Button>
      </Group>
    </Modal>
  );
}
