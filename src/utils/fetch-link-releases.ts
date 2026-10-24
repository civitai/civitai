import { CIVITAI_LINK_DESKTOP_RELEASES } from '~/components/CivitaiLink/civitai-link-paths';
import { detectOS } from './detect-os';

type GithubRelease = {
  tag_name: string;
  assets: {
    name: string;
    browser_download_url: string;
  }[];
};

/**
 * Matched as a SUFFIX. Every release also ships `.blockmap` and `latest*.yml`
 * siblings, so a substring match returns whichever of them GitHub happens to
 * list first.
 */
const installerExtensions = {
  Windows: '.exe',
  Mac: '.dmg',
  Linux: '.deb',
} as const;

export type DownloadableOS = keyof typeof installerExtensions;

export async function fetchLinkReleases(userAgent: string) {
  const res = await fetch(
    'https://api.github.com/repos/civitai/civitai-link-desktop/releases/latest'
  );
  const data: GithubRelease = await res.json();
  const os = detectOS(userAgent);

  const downloads = Object.entries(installerExtensions).reduce<
    Partial<Record<DownloadableOS, string>>
  >((acc, [key, extension]) => {
    const asset = data.assets?.find((x) => x.name?.toLowerCase().endsWith(extension));
    if (asset) acc[key as DownloadableOS] = asset.browser_download_url;
    return acc;
  }, {});

  return {
    os,
    tag_name: data.tag_name,
    // An unrecognised OS gets the releases page. It used to match on '', which is
    // true of every asset, so it offered the Windows installer to everyone else.
    href: (os === 'Unknown' ? undefined : downloads[os]) ?? CIVITAI_LINK_DESKTOP_RELEASES,
    downloads,
  };
}
