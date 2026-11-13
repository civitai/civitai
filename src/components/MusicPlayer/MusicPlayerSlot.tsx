import dynamic from 'next/dynamic';

const MusicPlayerMount = dynamic(() => import('~/components/MusicPlayer/MusicPlayerMount'), {
  ssr: false,
});

/**
 * The global player's place in the site chrome. Its code loads only while `enabled` (the `music`
 * flag), so pages without it pay nothing; turning it off closes an active player.
 */
export function MusicPlayerSlot({ enabled }: { enabled: boolean }) {
  return enabled ? <MusicPlayerMount /> : null;
}
