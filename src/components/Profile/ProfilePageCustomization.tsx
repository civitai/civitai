import { getEdgeUrl } from '~/client-utils/edge-url';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useComputedColorScheme } from '@mantine/core';
import {
  profileBarBackground,
  profileCardBackground,
  profileCardInk,
  themePanel,
} from '~/components/Profile/profile-card-color';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Flags } from '~/shared/utils/flags';
import { trpc } from '~/utils/trpc';

/**
 * A member's page background and card colour (profile redesign), as page-scoped CSS: cards read
 * `--profile-card-bg`, and the content column carries the background. The background shows only
 * within the viewer's browsing level; there is no blur to reveal it behind.
 */
export function ProfilePageCustomization({ userId }: { userId: number }) {
  const features = useFeatureFlags();
  const browsingLevel = useBrowsingLevelDebounced();
  const scheme = useComputedColorScheme('dark');
  const { data } = trpc.userProfile.customization.useQuery(
    { userId, browsingLevel },
    { enabled: !!features.profileRedesign }
  );
  if (!features.profileRedesign || !data) return null;

  const background =
    data.background && Flags.intersects(browsingLevel, data.background.nsfwLevel)
      ? data.background
      : null;
  // Light-mode visitors get the light colours when the member set them, else the dark ones.
  const theme = (scheme === 'light' && data.pageTheme?.light) || data.pageTheme?.dark;
  const cardColor = theme?.color ?? null;
  const cardOpacity = theme?.opacity ?? null;
  // Without a colour, an opacity (or a page background, which needs panels to sit on) uses the
  // theme's own panel colour; its text needs no change.
  const card = profileCardBackground(
    cardColor ?? (cardOpacity != null || background ? themePanel[scheme] : null),
    cardOpacity
  );
  const bar = profileBarBackground(cardColor);
  const cardInk = profileCardInk(cardColor, cardOpacity, scheme);
  // The bar is the same colour, nearly opaque, so it can need the other ink.
  const barInk = profileCardInk(cardColor, 93, scheme);
  const sidebarColor = data.pageTheme?.sidebar?.color ?? null;
  // The sidebar's gradient starts at its colour and darkens, so read its ink at the top.
  const sidebarInk = profileCardInk(sidebarColor, 100, scheme);
  if (!background && !card && !sidebarColor) return null;

  const rules = [
    card &&
      `:root{--profile-card-bg:${card}}[data-profile-card]{background-color:${card}!important}`,
    cardInk && `:root{${inkVars(cardInk)}}[data-profile-card]{${mantineInk}}`,
    sidebarColor &&
      sidebarInk &&
      `[data-profile-sidebar]{background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.45)),${sidebarColor}!important;${inkVars(
        sidebarInk
      )}${mantineInk}}`,
    // Light-variant buttons (Tip) are a tint of their own colour, which washes out on a light surface.
    cardInk === 'dark' &&
      '[data-profile-card] .mantine-Button-root[data-variant="light"]{background-color:rgba(26,27,30,.85)}',
    sidebarInk === 'dark' &&
      '[data-profile-sidebar] .mantine-Button-root[data-variant="light"]{background-color:rgba(26,27,30,.85)}',
    bar &&
      barInk &&
      `[data-subnav],[data-profile-bar]{background-color:${bar}!important;backdrop-filter:blur(8px);${inkVars(
        barInk
      )}${mantineInk}}`,
    // Wider gutters so the background frames the content; panels frost it lightly, so it still shows.
    background &&
      '[data-profile-content]{padding-left:24px;padding-right:24px}:root{--profile-card-blur:blur(4px)}',
  ].filter(Boolean);

  return (
    <>
      <style>{rules.join('')}</style>
      {background && (
        // Pinned to the top of the scroll area and one screen tall, so it never grows with the
        // profile or scrolls away: the content scrolls over it, under a light scrim.
        <div
          aria-hidden
          className="pointer-events-none sticky top-0 z-[-1] -mx-6 -mb-[100dvh] h-[100dvh]"
          style={{
            backgroundImage: `linear-gradient(rgba(14,15,18,.3),rgba(14,15,18,.3)),url(${JSON.stringify(
              getEdgeUrl(background.url, { width: 1920 })
            )})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center top',
          }}
        />
      )}
    </>
  );
}

// Text that stays legible on the member's card colour: Mantine's text variables, re-pointed inside
// the tinted areas. Panels read the same variables from ProfileSection.module.css.

const inks = {
  dark: { text: '#212529', dimmed: '#495057', bright: '#000000', anchor: '#1864ab' },
  light: { text: '#c1c2c5', dimmed: '#909296', bright: '#ffffff', anchor: '#74c0fc' },
};
const inkVars = (ink: keyof typeof inks) =>
  `--profile-ink-text:${inks[ink].text};--profile-ink-dimmed:${inks[ink].dimmed};--profile-ink-bright:${inks[ink].bright};--profile-ink-anchor:${inks[ink].anchor};`;
const mantineInk =
  'color:var(--profile-ink-text);--mantine-color-text:var(--profile-ink-text);--mantine-color-dimmed:var(--profile-ink-dimmed);--mantine-color-bright:var(--profile-ink-bright);--mantine-color-anchor:var(--profile-ink-anchor);';
