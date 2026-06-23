import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import React from 'react';
import dynamic from 'next/dynamic';
import type { AnnouncementType } from '~/server/schema/announcement.schema';

const AnnouncementsCarousel = dynamic(
  () => import('~/components/Announcements/AnnouncementsCarousel')
);

export function Announcements({
  className,
  type = 'site',
}: {
  className?: string;
  type?: AnnouncementType;
}) {
  const { data } = useGetAnnouncements(type);

  const announcements = data.filter((x) => !x.dismissed);

  if (!announcements.length) return null;

  return <AnnouncementsCarousel className={className} type={type} />;
}
