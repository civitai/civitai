import { Accordion, SimpleGrid, Stack, createStyles } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconList, IconPaperclip } from '@tabler/icons-react';

import { AttachmentCard } from '~/components/Article/Detail/AttachmentCard';
import { TableOfContent } from '~/components/Article/Detail/TableOfContent';
import { CreatorCard } from '~/components/CreatorCard/CreatorCard';
import { useHeadingsData } from '~/hooks/useHeadingsData';
import { hideMobile } from '~/libs/sx-helpers';
import { ArticleGetById } from '~/types/router';

const useStyles = createStyles((theme) => ({
  sidebar: {
    position: 'sticky',
    top: 70 + theme.spacing.xl,
  },
}));

export function Sidebar({ attachments, creator }: Props) {
  const { classes, theme } = useStyles();
  const { nestedHeadings } = useHeadingsData();

  const [activeAccordion, setActiveAccordion] = useLocalStorage<string>({
    key: 'article-active-accordion',
    defaultValue: 'toc',
  });

  const hasAttachments = !!attachments.length;
  const hasHeadings = !!nestedHeadings.length;

  return (
    <aside className={classes.sidebar}>
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
                borderColor:
                  theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
                boxShadow: theme.shadows.sm,
              },
              control: {
                padding: theme.spacing.sm,
              },
            }}
          >
            <Stack>
              {!!nestedHeadings.length && (
                <Accordion.Item value="toc" sx={hideMobile}>
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
        <CreatorCard user={creator} />
      </Stack>
    </aside>
  );
}

type Props = { attachments: ArticleGetById['attachments']; creator: ArticleGetById['user'] };
