import { Badge } from '@mantine/core';
import { IconPhoto } from '@tabler/icons-react';
import Link from 'next/link';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import type { RouterOutput } from '~/types/router';
import { slugit } from '~/utils/string-helpers';

type ComicItem = RouterOutput['comics']['getPublicProjects']['items'][number];

export function ComicCard({ comic }: { comic: ComicItem }) {
  return (
    <Link
      href={`/comics/${comic.id}/${slugit(comic.name)}`}
      className="group block overflow-hidden rounded-lg border border-gray-700 bg-gray-800 transition-colors hover:border-gray-500"
    >
      {/* Cover Image */}
      <div className="relative aspect-[3/4] overflow-hidden bg-gray-900">
        {comic.thumbnailUrl ? (
          <img
            src={getEdgeUrl(comic.thumbnailUrl, { width: 450 })}
            alt={comic.name}
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <IconPhoto size={36} className="text-gray-600" />
          </div>
        )}

        {/* NSFW badge */}
        {comic.nsfwLevel > 1 && (
          <Badge size="xs" color="red" variant="filled" className="absolute left-2 top-2">
            NSFW
          </Badge>
        )}

        {/* Genre badge */}
        {comic.genre && (
          <Badge size="xs" variant="light" className="absolute right-2 top-2">
            {comic.genre.replace(/([A-Z])/g, ' $1').trim()}
          </Badge>
        )}
      </div>

      {/* Body */}
      <div className="p-3">
        <h3 className="text-sm font-medium truncate">{comic.name}</h3>

        <div className="mt-1.5 flex items-center gap-1.5">
          <UserAvatarSimple {...comic.user} />
        </div>

        {/* Latest chapters */}
        {comic.latestChapters && comic.latestChapters.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5">
            {comic.latestChapters.map((ch, i) => (
              <span key={`${ch.projectId}-${ch.position}`} className="text-xs text-gray-400">
                Ch. {comic.chapterCount - i}
                {ch.publishedAt && <> &middot; {formatRelativeDate(ch.publishedAt)}</>}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

function formatRelativeDate(date: Date | string): string {
  const now = new Date();
  const d = new Date(date);
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString();
}
