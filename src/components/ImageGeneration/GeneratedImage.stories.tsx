import { Checkbox } from '@mantine/core';
import {
  IconDotsVertical,
  IconHeart,
  IconThumbDown,
  IconThumbUp,
  IconWand,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';

import classes from './GeneratedImage.module.css';

// Standalone card without Next.js dependencies
function ImageCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={clsx(
        'relative flex flex-col overflow-hidden rounded-md border',
        'border-gray-3 bg-gray-0 dark:border-dark-4 dark:bg-dark-6',
        className
      )}
    >
      {children}
    </div>
  );
}

function GeneratedImagePreview({
  aspect = '1 / 1',
  favorite = false,
  feedback,
}: {
  aspect?: string;
  favorite?: boolean;
  feedback?: 'liked' | 'disliked';
}) {
  const [fav, setFav] = useState(favorite);
  const [fb, setFb] = useState<'liked' | 'disliked' | undefined>(feedback);

  return (
    <ImageCard className={classes.imageWrapper}>
      {/* Image area */}
      <div className="relative flex items-center justify-center" style={{ aspectRatio: aspect }}>
        {/* Placeholder gradient */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(135deg, #1a1b1e 0%, #25262b 50%, #2c2e33 100%)',
          }}
        />
        <span className="relative text-xs" style={{ color: '#555' }}>
          image
        </span>

        {/* Top-left checkbox */}
        <label className="absolute left-3 top-3">
          <Checkbox size="sm" />
        </label>

        {/* Top-right dots menu */}
        <div className="absolute right-3 top-3">
          <IconDotsVertical
            size={22}
            color="#fff"
            style={{ filter: 'drop-shadow(1px 1px 2px rgb(0 0 0 / 50%))' }}
          />
        </div>

        {/* Inner shadow overlay */}
        <div className="pointer-events-none absolute inset-0 rounded-md shadow-[inset_0_0_2px_1px_rgba(255,255,255,0.2)]" />
      </div>

      {/* Footer */}
      <div className={clsx(classes.actionsFooter, 'flex w-full')}>
        <button
          className={clsx(classes.footerButton, fav && 'text-red-5')}
          onClick={() => setFav((v) => !v)}
        >
          <IconHeart size={16} />
        </button>

        <div className={classes.footerDivider} />

        <button className={classes.footerButton}>
          <IconWand size={16} />
        </button>

        <div className={classes.footerDivider} />

        <button
          className={clsx(classes.footerButton, fb === 'liked' && 'text-green-5')}
          onClick={() => setFb((v) => (v === 'liked' ? undefined : 'liked'))}
        >
          <IconThumbUp size={16} />
        </button>

        <div className={classes.footerDivider} />

        <button
          className={clsx(classes.footerButton, fb === 'disliked' && 'text-red-5')}
          onClick={() => setFb((v) => (v === 'disliked' ? undefined : 'disliked'))}
        >
          <IconThumbDown size={16} />
        </button>
      </div>
    </ImageCard>
  );
}

export const Square = () => (
  <div style={{ width: 240 }}>
    <GeneratedImagePreview aspect="1 / 1" />
  </div>
);

export const Portrait = () => (
  <div style={{ width: 200 }}>
    <GeneratedImagePreview aspect="2 / 3" />
  </div>
);

export const Landscape = () => (
  <div style={{ width: 320 }}>
    <GeneratedImagePreview aspect="16 / 9" />
  </div>
);

export const WithFavorite = () => (
  <div style={{ width: 240 }}>
    <GeneratedImagePreview aspect="1 / 1" favorite />
  </div>
);

export const WithFeedback = () => (
  <div style={{ width: 240 }}>
    <GeneratedImagePreview aspect="1 / 1" feedback="liked" />
  </div>
);

export const Grid = () => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 180px)', gap: 8 }}>
    <GeneratedImagePreview aspect="1 / 1" />
    <GeneratedImagePreview aspect="2 / 3" />
    <GeneratedImagePreview aspect="1 / 1" favorite />
  </div>
);
