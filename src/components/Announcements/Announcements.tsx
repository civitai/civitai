import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import React from 'react';
import dynamic from 'next/dynamic';

const AnnouncementsCarousel = dynamic(
  () => import('~/components/Announcements/AnnouncementsCarousel')
);

export function Announcements() {
  const { data } = useGetAnnouncements();

  const announcements = data.filter((x) => !x.dismissed);

  if (!announcements.length) return null;

  return <AnnouncementsCarousel />;
}
