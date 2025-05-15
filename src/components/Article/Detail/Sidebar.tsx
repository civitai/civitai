import {
  Accordion,
  SimpleGrid,
  Stack,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconList, IconPaperclip } from '@tabler/icons-react';

import { AttachmentCard } from '~/components/Article/Detail/AttachmentCard';
import { TableOfContent } from '~/components/Article/Detail/TableOfContent';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { useHeadingsData } from '~/hooks/useHeadingsData';
import type { ArticleGetById } from '~/server/services/article.service';
import utilClasses from '~/lib/helpers.module.scss';

export function Sidebar({ articleId, attachments, creator }: Props) {
  const { nestedHeadings } = useHeadingsData();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const [activeAccordion, setActiveAccordion] = useLocalStorage<string>({
    key: 'article-active-accordion',
    defaultValue: 'toc',
  });

  const hasAttachments = !!attachments.length;
  const hasHeadings = !!nestedHeadings.length;

  return (
    <aside
      style={{
        position: 'sticky',
        top: 70 + theme.spacing.xl,
      }}
    >
      <Stack>
        {(hasAttachments || hasHeadings) && (
          <Accordion
            variant="separated"
            defaultValue="toc"
            value={activeAccordion}
            onChange={(value) => (value ? setActiveAccordion(value) : undefined)}
            styles={{
              content: { padding: 0 },
              item: {
                overflow: 'hidden',
                borderColor: colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
                boxShadow: theme.shadows.sm,
              },
              control: {
                padding: theme.spacing.sm,
              },
            }}
          >
            <Stack>
              {!!nestedHeadings.length && (
                <Accordion.Item value="toc" className={utilClasses.hideMobile}>
                  <Accordion.Control icon={<IconList size={20} />}>
                    Table of Contents
                  </Accordion.Control>
                  <Accordion.Panel>
                    <TableOfContent headings={nestedHeadings} />
                  </Accordion.Panel>
                </Accordion.Item>
              )}
              {hasAttachments && (
                <Accordion.Item value="attachments">
                  <Accordion.Control icon={<IconPaperclip size={20} />}>
                    Attachments
                  </Accordion.Control>
                  <Accordion.Panel>
                    <SimpleGrid cols={1} spacing={2}>
                      {attachments.map((attachment) => (
                        <AttachmentCard key={attachment.id} {...attachment} />
                      ))}
                    </SimpleGrid>
                  </Accordion.Panel>
                </Accordion.Item>
              )}
            </Stack>
          </Accordion>
        )}
        <SmartCreatorCard user={creator} tipBuzzEntityId={articleId} tipBuzzEntityType="Article" />
      </Stack>
    </aside>
  );
}

type Props = {
  articleId: number;
  attachments: ArticleGetById['attachments'];
  creator: ArticleGetById['user'];
};
