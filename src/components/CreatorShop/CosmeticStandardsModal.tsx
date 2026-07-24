import { Center, Loader, Modal, Text } from '@mantine/core';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import { COSMETIC_STANDARDS_SLUG } from '~/components/CreatorShop/creator-shop.constants';
import { trpc } from '~/utils/trpc';

// The cosmetic quality standards (src/static-content/cosmetic-standards.md)
// rendered in a dialog so creators can read them without leaving the
// submission flow. The same doc is also served at /content/cosmetic-standards.
export function CosmeticStandardsModal() {
  const dialog = useDialogContext();
  const { data: content, isLoading } = trpc.content.get.useQuery({
    slug: [COSMETIC_STANDARDS_SLUG],
  });

  return (
    <Modal {...dialog} size="lg" title={content?.title ?? 'Cosmetic Quality Standards'}>
      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : content ? (
        <TypographyStylesWrapper>
          <CustomMarkdown rehypePlugins={[rehypeRaw, remarkGfm]}>{content.content}</CustomMarkdown>
        </TypographyStylesWrapper>
      ) : (
        <Text size="sm" c="dimmed">
          Could not load the standards. Please try again later.
        </Text>
      )}
    </Modal>
  );
}
