import { detectOS } from './detect-os';

type GithubReleases = {
  tag_name: string;
  assets: {
    browser_download_url: string;
  }[];
};

export async function fetchLinkReleases(userAgent: string) {
  const res = await fetch(
    'https://api.github.com/repos/civitai/civitai-link-desktop/releases/latest'
  );
  const data: GithubReleases = await res.json();
  const os = detectOS(userAgent);

  const extensions = {
    Windows: 'exe',
    Mac: 'dmg',
    Linux: 'deb',
    Unknown: '',
  };

  const downloadUrl = data.assets.find((asset) =>
    asset.browser_download_url.includes(extensions[os])
  );

  return {
    os,
    tag_name: data.tag_name,
    href:
      downloadUrl?.browser_download_url ||
      'https://github.com/civitai/civitai-link-desktop/releases/latest',
  };
}
