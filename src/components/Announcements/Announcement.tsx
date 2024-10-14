import { ActionIcon, Button, ButtonVariant, Title } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { useAnnouncementsContext } from '~/components/Announcements/AnnouncementsProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { GetAnnouncement } from '~/server/services/announcement.service';

export function Announcement({ announcement }: { announcement: GetAnnouncement }) {
  const { actions, image, dismissible = true } = announcement.metadata || {};

  const { dismiss } = useAnnouncementsContext();

  return (
    <div className="relative flex card">
      {dismissible && (
        <ActionIcon
          variant="subtle"
          radius="xl"
          color="red"
          onClick={() => dismiss(announcement.id)}
          className="absolute right-2 top-2"
        >
          <IconX size={20} />
        </ActionIcon>
      )}
      <div className="flex items-center">
        {image && (
          <div className="@max-md:hidden">
            <EdgeMedia src={image} width={200} alt="Announcement banner image" />
          </div>
        )}
        <div className="mr-5 flex flex-1 flex-col gap-3 p-3">
          <Title order={3}>{announcement.title}</Title>
          <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
            {announcement.content}
          </CustomMarkdown>
          {actions && (
            <div className="flex gap-2">
              {actions.map((action, index) => (
                <Link key={index} href={action.link} passHref>
                  <Button
                    component="a"
                    variant={action.variant ? (action.variant as ButtonVariant) : undefined}
                    color={action.color ?? announcement.color}
                  >
                    {action.linkText}
                  </Button>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
