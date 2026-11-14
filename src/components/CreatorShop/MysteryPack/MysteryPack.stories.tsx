import { useEffect } from 'react';
import { MysteryPackComposerModal } from '~/components/CreatorShop/MysteryPack/MysteryPackComposerModal';
import { MysteryPacksManagePanel } from '~/components/CreatorShop/MysteryPack/MysteryPacksManagePanel';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { MysteryBoxCard } from '~/components/MysteryBox/MysteryBoxCard';
import { MysteryBoxOddsPage } from '~/components/MysteryBox/MysteryBoxOddsPage';
import { MysteryBoxCatalogCard } from '~/components/MysteryBox/MysteryBoxCatalogCard';
import { AppProvider } from '~/providers/AppProvider';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { RouterOutput } from '~/types/router';
import { StoryTRPCProvider } from '../../../../.ladle/trpc';

const TYPES = ['Badge', 'ProfileDecoration', 'ContentDecoration', 'ProfileBackground'] as const;
const item = (id: number, value: number | null, problem: string | null = null) => ({
  cosmeticId: id,
  name: `Neon ${
    ['frame', 'badge', 'comet', 'glow', 'spark', 'orbit', 'wave', 'prism'][id % 8]
  } ${id}`,
  type: TYPES[id % 4],
  data: {},
  value,
  problem,
});
type Candidates = RouterOutput['creatorShop']['getMysteryPackCandidates'];
type Packs = RouterOutput['creatorShop']['getMyMysteryPacks'];
type SellerView = RouterOutput['mysteryBox']['getForSeller'][number];
type CatalogEntry = RouterOutput['mysteryBox']['getForCreator'][number];
type OddsPageData = NonNullable<RouterOutput['mysteryBox']['getOddsPage']>;

const candidates: Candidates = [
  ...Array.from({ length: 16 }, (_, i) => item(i + 1, [500, 800, 1200, 3000][i % 4])),
  item(90, null, 'Items with limited stock or an end date can’t go in a mystery pack'),
  item(91, null, 'Only items approved and live in your shop can go in a mystery pack'),
];
const proposal = {
  steepness: 'standard' as const,
  price: 650,
  tiers: [
    { key: 'common', cosmeticIds: [1, 2, 3, 4, 5, 6] },
    { key: 'rare', cosmeticIds: [7, 8, 9] },
    { key: 'legendary', cosmeticIds: [10] },
  ],
};
const packs: Packs = [
  {
    boxId: 1,
    name: 'Neon Night Pack',
    description: null,
    version: 2,
    boxStatus: 'published',
    listing: { id: 5, status: 'Published', unitAmount: 650 },
    pending: null,
    proposal,
    rejection: null,
  },
  {
    boxId: 2,
    name: 'Comet Crate with a very long name that keeps going and going past the edge',
    description: null,
    version: 1,
    boxStatus: 'draft',
    listing: { id: 6, status: 'RequestedChanges', unitAmount: 900 },
    pending: null,
    proposal,
    rejection: 'The price is too high for the cheapest item. Lower it or swap one in.',
  },
  {
    boxId: 3,
    name: 'Orbit Box',
    description: null,
    version: 3,
    boxStatus: 'published',
    listing: { id: 7, status: 'Published', unitAmount: 700 },
    pending: { id: 9, status: 'pending', baseVersion: 3, proposal, note: null },
    proposal,
    rejection: null,
  },
];
const tiers = [
  { id: 1, key: 'common', name: 'Common', color: null, weight: 8000, sortOrder: 0 },
  { id: 2, key: 'rare', name: 'Rare', color: null, weight: 1700, sortOrder: 1 },
  { id: 3, key: 'legendary', name: 'Legendary', color: null, weight: 300, sortOrder: 2 },
];
const contents = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
  contentId: n,
  tierId: n <= 6 ? 1 : n <= 9 ? 2 : 3,
  cosmeticId: n,
  name: `Item ${n}`,
  url: null,
  fit: null,
  left: true,
}));
const view: SellerView = {
  boxDefinitionId: 1,
  name: 'Neon Night Pack',
  description: null,
  version: 2,
  team: undefined,
  art: null,
  listing: { shopItemId: 5, title: 'Neon Night Pack', unitAmount: 650, availableTo: null },
  packListing: null,
  tiers,
  contents,
  heldBoxItemIds: [],
  seller: { id: 77, username: 'testcreator' },
};
const flags = {
  buzz: true,
  creatorShop: true,
  cosmeticPacks: true,
  mysteryBox: true,
  creatorMysteryPacks: true,
  stickers: true,
} as unknown as FeatureAccess;
const appProps = {
  settings: {},
  serverDomains: {
    green: { primary: 'civitai.green' },
    blue: { primary: 'civitai.com' },
    red: { primary: 'civitai.red' },
  },
  domain: 'green',
  host: 'civitai.green',
  isAuthed: false,
} as unknown as Omit<React.ComponentProps<typeof AppProvider>, 'children'>;
const Flags = ({ children }: { children: React.ReactNode }) => (
  <AppProvider {...appProps}>
    <FeatureFlagsProvider flags={flags}>
      <ContainerProvider containerName="root">{children}</ContainerProvider>
    </FeatureFlagsProvider>
  </AppProvider>
);
const mocks = {
  'user.getFeatureFlags': {},
  'mysteryBox.getForSeller': [view],
  'creatorShop.getMysteryPackCandidates': candidates,
  'creatorShop.getFees': { mysteryPack: 100, pack: 100, item: 50 },
  'creatorShop.getMyMysteryPacks': packs,
  'buzz.getBuzzAccount': { yellow: 5000, green: 200, blue: 0 },
};

function Open({ pack }: { pack?: (typeof packs)[number] }) {
  useEffect(() => {
    dialogStore.trigger({ component: MysteryPackComposerModal, props: { pack } });
  }, [pack]);
  return <DialogProvider />;
}

export const ComposerNew = () => (
  <StoryTRPCProvider mocks={mocks}>
    <Flags>
      <Open />
    </Flags>
  </StoryTRPCProvider>
);
export const ComposerEdit = () => (
  <StoryTRPCProvider mocks={mocks}>
    <Flags>
      <Open pack={packs[0]} />
    </Flags>
  </StoryTRPCProvider>
);
export const Manage = () => (
  <StoryTRPCProvider mocks={mocks}>
    <Flags>
      <MysteryPacksManagePanel canBuild />
      <DialogProvider />
    </Flags>
  </StoryTRPCProvider>
);
export const StorefrontCard = () => (
  <StoryTRPCProvider mocks={mocks}>
    <Flags>
      <DialogProvider />
      <MysteryBoxCard source={{ seller: 77 }} view={view} color="var(--mantine-color-violet-5)" />
    </Flags>
  </StoryTRPCProvider>
);
export const CatalogCard = () => (
  <StoryTRPCProvider mocks={mocks}>
    <Flags>
      <MysteryBoxCatalogCard
        box={
          {
            boxDefinitionId: 1,
            name: 'Neon Night Pack',
            description: null,
            unitAmount: 650,
            pack: null,
            tiers,
            contents: contents.map(({ contentId, tierId }) => ({ contentId, tierId, team: null })),
            teams: [],
            seller: { id: 77, username: 'testcreator' },
          } satisfies CatalogEntry
        }
      />
    </Flags>
  </StoryTRPCProvider>
);

export const SellerOdds = () => (
  <StoryTRPCProvider mocks={mocks}>
    <Flags>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
        <MysteryBoxOddsPage
          onTeamChange={() => undefined}
          page={
            {
              boxDefinitionId: 1,
              name: 'Neon Night Pack',
              description: null,
              version: 3,
              archived: false,
              noun: 'item',
              event: null,
              teams: [],
              price: 650,
              seller: { id: 77, username: 'testcreator' },
              pack: null,
              tiers,
              contents: contents.map((c) => ({ ...c, team: null })),
              history: [
                { version: 3, createdAt: new Date('2026-11-12'), changes: ['Price 850 → 650'] },
                { version: 1, createdAt: new Date('2026-11-10'), changes: ['Published'] },
              ],
              historyComplete: true,
            } satisfies OddsPageData
          }
        />
      </div>
    </Flags>
  </StoryTRPCProvider>
);
