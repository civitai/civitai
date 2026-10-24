import { afterEach, describe, expect, it, vi } from 'vitest';
import { CIVITAI_LINK_DESKTOP_RELEASES } from '~/components/CivitaiLink/civitai-link-paths';
import { fetchLinkReleases } from '~/utils/fetch-link-releases';

// The asset list of a real release (v1.21.0), in the order the GitHub API returns it.
const ASSETS = [
  'civitai-link-1.21.0-setup.exe',
  'civitai-link-1.21.0-setup.exe.blockmap',
  'Civitai-Link-1.21.0-universal-mac.zip',
  'civitai-link-1.21.0.AppImage',
  'civitai-link-1.21.0.dmg',
  'civitai-link-1.21.0.dmg.blockmap',
  'civitai-link_1.21.0_amd64.deb',
  'Civitai.Link-1.21.0-universal-mac.zip.blockmap',
  'latest-linux.yml',
  'latest-mac.yml',
  'latest.yml',
];

const AGENTS = {
  Windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  Linux: 'Mozilla/5.0 (X11; Linux x86_64)',
  Unknown: 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26)',
};

const mockRelease = (names: string[] = ASSETS) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      json: async () => ({
        tag_name: 'v1.21.0',
        assets: names.map((name) => ({
          name,
          browser_download_url: `https://github.com/civitai/civitai-link-desktop/releases/download/v1.21.0/${name}`,
        })),
      }),
    }))
  );

const asset = (name: string) =>
  `https://github.com/civitai/civitai-link-desktop/releases/download/v1.21.0/${name}`;

describe('fetchLinkReleases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const INSTALLERS = {
    Windows: asset('civitai-link-1.21.0-setup.exe'),
    Mac: asset('civitai-link-1.21.0.dmg'),
    Linux: asset('civitai-link_1.21.0_amd64.deb'),
  };

  it('resolves an installer per OS, never a blockmap or an update manifest', async () => {
    mockRelease();

    const { downloads } = await fetchLinkReleases(AGENTS.Windows);

    expect(downloads).toEqual(INSTALLERS);
  });

  // The assertion above passes under a SUBSTRING match too, purely because GitHub
  // happens to return each installer before its `.blockmap`. Nothing guarantees that
  // order — it is upload order — so this reverses it. `.exe.blockmap` first is what
  // separates a suffix match from a substring one; without this case the rule the
  // matcher exists to enforce is untested.
  it('still resolves the installer when the blockmap is listed first', async () => {
    mockRelease([
      'civitai-link-1.21.0-setup.exe.blockmap',
      'civitai-link-1.21.0-setup.exe',
      'civitai-link-1.21.0.dmg.blockmap',
      'civitai-link-1.21.0.dmg',
      'civitai-link_1.21.0_amd64.deb',
    ]);

    const { downloads } = await fetchLinkReleases(AGENTS.Windows);

    expect(downloads).toEqual(INSTALLERS);
  });

  it.each(['Windows', 'Mac', 'Linux'] as const)('points %s at its own installer', async (os) => {
    mockRelease();

    const { href, downloads } = await fetchLinkReleases(AGENTS[os]);

    expect(href).toBe(downloads[os]);
  });

  // The regression this replaced: `Unknown` matched on '', which every asset
  // satisfies, so it returned the first one — a Windows installer offered to a
  // machine that demonstrably is not Windows.
  it('falls back to the releases page for an unrecognised OS', async () => {
    mockRelease();

    const { os, href } = await fetchLinkReleases(AGENTS.Unknown);

    expect(os).toBe('Unknown');
    expect(href).toBe(CIVITAI_LINK_DESKTOP_RELEASES);
  });

  it('omits an OS the release has no installer for, and falls back for the current one', async () => {
    mockRelease(['civitai-link-1.21.0-setup.exe', 'latest.yml']);

    const { href, downloads } = await fetchLinkReleases(AGENTS.Mac);

    expect(downloads).toEqual({ Windows: asset('civitai-link-1.21.0-setup.exe') });
    expect(href).toBe(CIVITAI_LINK_DESKTOP_RELEASES);
  });
});
