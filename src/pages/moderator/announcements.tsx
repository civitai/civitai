import { ActionIcon, Badge, Button, Pagination } from '@mantine/core';
import { IconCopy, IconPencil, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { z } from 'zod';
import { Announcement } from '~/components/Announcements/Announcement';
import { AnnouncementEditModal } from '~/components/Announcements/AnnouncementEditModal';
import { Page } from '~/components/AppLayout/Page';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { UpsertAnnouncementSchema } from '~/server/schema/announcement.schema';
import { trpc } from '~/utils/trpc';

const schema = z.object({ page: z.coerce.number().default(1) });

export function AnnouncementsPage() {
  const router = useRouter();
  const { page } = schema.parse(router.query);
  const queryUtils = trpc.useUtils();

  const { data, isLoading } = trpc.announcement.getAnnouncementsPaged.useQuery({ page });
  const deleteMutation = trpc.announcement.deleteAnnouncement.useMutation({
    onSuccess: () => {
      queryUtils.announcement.getAnnouncementsPaged.invalidate();
    },
  });

  function openEdit(announcement?: Partial<UpsertAnnouncementSchema>) {
    dialogStore.trigger({
      component: AnnouncementEditModal,
      props: { announcement },
    });
  }

  function handlePaginationChange(page: number) {
    router.replace({ query: { ...router.query, page } }, undefined, { shallow: true });
  }

  if (isLoading) return <PageLoader />;

  const now = Date.now();

  return (
    <div className="container flex flex-col gap-2">
      <div className="flex justify-end">
        <Button onClick={() => openEdit()}>Create New Announcement</Button>
      </div>
      {data?.items.map((announcement) => {
        const startsAt = (announcement.startsAt ?? now).getTime();
        const endsAt = (announcement.endsAt ?? new Date('2100-12-31')).getTime();
        const active = startsAt <= now && now <= endsAt;

        return (
          <div key={announcement.id} style={!active ? { opacity: 0.5 } : undefined}>
            <Announcement
              announcement={announcement}
              dismissible={false}
              moderatorActions={
                <div className="flex items-center gap-1">
                  {announcement.disabled ? (
                    <Badge color="red">Disabled</Badge>
                  ) : active ? (
                    <Badge>Active</Badge>
                  ) : null}
                  <ActionIcon
                    onClick={() => {
                      const { id, startsAt, endsAt, ...rest } = announcement;
                      openEdit(rest);
                    }}
                  >
                    <IconCopy />
                  </ActionIcon>
                  <ActionIcon onClick={() => openEdit(announcement)}>
                    <IconPencil />
                  </ActionIcon>
                  <PopConfirm
                    onConfirm={() => deleteMutation.mutate({ id: announcement.id })}
                    withinPortal
                  >
                    <ActionIcon loading={deleteMutation.isLoading} color="red">
                      <IconTrash />
                    </ActionIcon>
                  </PopConfirm>
                </div>
              }
            />
          </div>
        );
      })}
      {data && (
        <div className="flex justify-end">
          <Pagination value={page} total={data.totalPages} onChange={handlePaginationChange} />
        </div>
      )}
    </div>
  );
}

export default Page(AnnouncementsPage, { features: (features) => features.announcements });
