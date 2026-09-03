import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { NavKey } from '~/shared/constants/nav.constants';

/**
 * React-free by design: the node `unit` project is the gating tier, and a table living in a `.tsx`
 * that imports Mantine and tRPC can only be reached from there by scanning source. That is why
 * `homeOptions` had no tests. Icons are looked up by key in `nav-icons.tsx`.
 */

/** Which of the modal's two groups an item sits in. Visibility is separate — see `NavConfig`. */
export type NavGroup = 'bar' | 'more';

/**
 * Gates take the whole context rather than `FeatureAccess` alone. Neighbouring rows in the user
 * menu already gate on things a flag cannot express — onboarding bits, mute state, a pending
 * count — so a `features`-only signature means the next item added silently gets no gate.
 */
export type NavGateContext = {
  features: FeatureAccess;
  isAuthed: boolean;
};

export type NavRegistryEntry = {
  key: NavKey;
  url: string;
  defaultGroup: NavGroup;
  /** Off by default. Group membership still applies — the item is just switched off. */
  defaultHidden?: true;
  /**
   * Cannot be moved, reordered or switched off. Only `home` — it is the way back from anywhere,
   * so a user who hides it has no route home from a page whose own nav they broke.
   */
  locked?: true;
  visible?: (ctx: NavGateContext) => boolean;
  new?: Date;
  classes?: string[];
};

const authed = (ctx: NavGateContext) => ctx.isAuthed;

/**
 * Order is the default order. `defaultGroup` replaces the old `grouped` flag plus the container
 * queries that used to decide placement by viewport width; `defaultHidden` replaces the two
 * account-settings switches.
 *
 * `posts` and `events` are `hidden` because that is what every user sees today: their flags are
 * `default: false`, so a user who never opened account settings has never seen those tabs.
 */
export const navRegistry: NavRegistryEntry[] = [
  { key: 'home', url: '/', defaultGroup: 'bar', locked: true },
  { key: 'models', url: '/models', defaultGroup: 'bar' },
  { key: 'images', url: '/images', defaultGroup: 'bar' },
  { key: 'videos', url: '/videos', defaultGroup: 'bar' },
  {
    key: '3d-models',
    url: '/3d-models',
    defaultGroup: 'bar',
    visible: (ctx) => ctx.features.model3dFeed,
    new: new Date('2026-06-30'),
  },
  { key: 'hubs', url: '/hubs', defaultGroup: 'bar', visible: (ctx) => ctx.features.userHubs },
  /**
   * `posts` and `events` carry NO gate. Their flags still exist and still seed a placement for
   * users who had them on, but placement is the config's job now — gating the rows would filter
   * them out of the customization modal for the default-off majority, leaving no way to turn them
   * on at all once the account switches retire.
   */
  { key: 'posts', url: '/posts', defaultGroup: 'bar', defaultHidden: true },
  {
    key: 'articles',
    url: '/articles',
    defaultGroup: 'bar',
    visible: (ctx) => ctx.features.articles,
  },
  {
    key: 'comics',
    url: '/comics',
    defaultGroup: 'bar',
    visible: (ctx) => ctx.features.comicCreator,
    new: new Date('2026-03-01'),
  },
  {
    key: 'bounties',
    url: '/bounties',
    defaultGroup: 'more',
    visible: (ctx) => ctx.features.bounties,
  },
  {
    key: 'challenges',
    url: '/challenges',
    defaultGroup: 'bar',
    visible: (ctx) => ctx.features.challengePlatform,
  },
  { key: 'events', url: '/events', defaultGroup: 'bar', defaultHidden: true },
  { key: 'updates', url: '/changelog', defaultGroup: 'bar' },
  {
    key: 'shop',
    url: '/shop',
    defaultGroup: 'bar',
    visible: (ctx) => ctx.features.cosmeticShop,
    classes: ['tabRainbow'],
  },

  /**
   * Promotable user-menu destinations. They stay in the user menu as well — the sub nav is an
   * additional surface, not a move — so they default to `hidden` and only appear once a user puts
   * them somewhere.
   *
   * All four are gated on `isAuthed` because only a signed-in user has anywhere to persist a
   * layout, and the resolver runs for anonymous visitors too. NOT because the user menu hides
   * them from signed-out visitors — `useGetMenuItems` has a second `visible: !currentUser` group
   * that offers Leaderboard and Auctions to anonymous users.
   */
  {
    key: 'leaderboard',
    url: '/leaderboard/overall',
    defaultGroup: 'more',
    defaultHidden: true,
    visible: authed,
  },
  {
    key: 'auctions',
    url: '/auctions',
    defaultGroup: 'more',
    defaultHidden: true,
    visible: (ctx) => ctx.isAuthed && ctx.features.auctions,
  },
  {
    key: 'vault',
    url: '/user/vault',
    defaultGroup: 'more',
    defaultHidden: true,
    visible: (ctx) => ctx.isAuthed && ctx.features.vault,
  },
  {
    key: 'collections',
    url: '/collections',
    defaultGroup: 'more',
    defaultHidden: true,
    visible: authed,
  },
];

export const navRegistryKeys = navRegistry.map((entry) => entry.key);
