import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  countAll,
  diffCounts,
  formatBaseline,
  memberName,
  memberObject,
  parse,
  productionSources,
  unwrap,
  walk,
  type Counts,
} from './source-ratchet.harness';

/**
 * One way to open a dialog (docs/dialog-system-plan.md):
 *
 * 1. Nothing imports `@mantine/modals`. Confirms are `openConfirm`, arbitrary content
 *    `openContentDialog`: one dialog stack, one z-index scheme.
 * 2. RATCHET: direct `dialogStore.trigger` / `toggle` outside `src/components/Dialog/`, per file.
 *    New code uses `openDialog(() => import('…'), props)`. The baseline is the existing direct
 *    triggers (statically imported dialogs); it may only shrink.
 * 3. Escape closes only the dialog opened last. Mantine closes every open modal whose
 *    `closeOnEscape` is on, so a dialog's `Modal`/`Drawer` takes it from `useDialogContext()`
 *    (the spread, or `closeOnEscape={dialog.closeOnEscape && …}`), or sets it to `false`.
 *
 * Known gap (3): only `{...dialog}` or `opened={dialog.opened}` mark a Modal/Drawer as a dialog's
 * own; one fed its open state any other way is not checked.
 */

const SRC = ['src/**/*.{ts,tsx}'];
const DIALOG_CORE = /^src\/components\/Dialog\//;

const BASELINE: Counts = {
  'src/components/AppBlocks/PageBlockHost.tsx': 3,
  'src/components/Apps/AppSettingsModal.tsx': 1,
  'src/components/Article/ArticleReframeModal.tsx': 1,
  'src/components/Article/ArticleShareDraftModal.tsx': 1,
  'src/components/Article/ArticleUpsertForm.tsx': 1,
  'src/components/AvatarGen/AvatarStylePicker.tsx': 1,
  'src/components/Buzz/BuzzPurchase.tsx': 1,
  'src/components/Buzz/BuzzPurchase/Buttons/BuzzPaddlePaymentButton.tsx': 1,
  'src/components/Buzz/BuzzPurchase/BuzzPurchaseImproved.tsx': 2,
  'src/components/Buzz/BuzzTopUpCard.tsx': 1,
  'src/components/Buzz/CreatorProgramV2/CreatorProgramV2.tsx': 3,
  'src/components/Buzz/FeatureCards/FeatureCards.tsx': 1,
  'src/components/Buzz/TipBuzzButton.tsx': 1,
  'src/components/Buzz/WithdrawalRequest/OwnedBuzzWithdrawalRequestsPaged.tsx': 1,
  'src/components/Challenges/ChallengeIndicator.tsx': 1,
  'src/components/CivitaiLink/CivitaiLinkPopover.tsx': 1,
  'src/components/Collections/components/RejectCollectionItemsModal.tsx': 1,
  'src/components/Comics/PanelCard.tsx': 1,
  'src/components/Comics/PanelDetailDrawer.tsx': 1,
  'src/components/Comics/PanelModal.tsx': 1,
  'src/components/Comics/ProjectSettingsModal.tsx': 1,
  'src/components/CosmeticShop/CosmeticPackPreviewModal.tsx': 1,
  'src/components/CosmeticShop/CosmeticShopItemPreviewModal.tsx': 1,
  'src/components/CreatorJourney/DiscordClaimGuideModal.tsx': 1,
  'src/components/CreatorJourney/RemovedImagesList.tsx': 1,
  'src/components/CreatorShop/CreatorShopSettingsModal.tsx': 1,
  'src/components/CreatorShop/CreatorShopSubmitModal.tsx': 1,
  'src/components/CreatorShop/Manage/ManageEmptyState.tsx': 1,
  'src/components/CreatorShop/Manage/ManageHeader.tsx': 4,
  'src/components/CreatorShop/Manage/manage.columns.tsx': 1,
  'src/components/CreatorShop/MysteryPack/MysteryPack.stories.tsx': 1,
  'src/components/CreatorShop/MysteryPack/MysteryPacksManagePanel.tsx': 2,
  'src/components/CreatorShop/Services/ManageServicesPanel.tsx': 3,
  'src/components/CreatorShop/Services/ServiceOfferingCard.tsx': 1,
  'src/components/CreatorShop/Services/deals/DealActionsPanel.tsx': 5,
  'src/components/Events/ScoredEvent/EventHatTile.tsx': 1,
  'src/components/Events/ScoredEvent/MyEventHats.tsx': 1,
  'src/components/Events/ScoredEvent/MyHatCard.tsx': 1,
  'src/components/Events/ScoredEvent/ScoredEventHero.tsx': 1,
  'src/components/Events/ScoredEvent/ShowcaseHatPicker.tsx': 1,
  'src/components/Events/ScoredEvent/roster/RosterCards.tsx': 1,
  'src/components/FeatureIntroduction/FeatureIntroduction.tsx': 2,
  'src/components/Generate/GenerationPaidAccessAlerts.tsx': 1,
  'src/components/Generation/GenerationSettings.tsx': 1,
  'src/components/Generation/Input/RecentImagesPicker.tsx': 1,
  'src/components/Generation/Input/SourceImageUpload.tsx': 1,
  'src/components/Generation/Input/SourceImageUploadMultiple.tsx': 4,
  'src/components/HomeBlocks/ScoredEventHomeBlock.tsx': 2,
  'src/components/Hubs/HubsLanding.tsx': 3,
  'src/components/Hubs/HubsLayout.tsx': 2,
  'src/components/Image/AsPosts/ImagesAsPostsInfinite.tsx': 1,
  'src/components/Image/hooks/useReportTosViolation.ts': 1,
  'src/components/ImageGeneration/GeneratedOutputWrapper.tsx': 2,
  'src/components/ImageGeneration/QueueItem.tsx': 1,
  'src/components/Inventory/InventoryBoxes.tsx': 1,
  'src/components/Inventory/InventoryHats.tsx': 1,
  'src/components/Model/LockReview/ComFaceDisputeAlert.tsx': 1,
  'src/components/Model/LockReview/useLockReviewAction.ts': 1,
  'src/components/Model/ModelVersions/ModelModerationCard.tsx': 1,
  'src/components/Model/ModelVersions/ModelVersionDetails.tsx': 4,
  'src/components/Moderation/FlaggedModelsList.tsx': 1,
  'src/components/Moderation/GenerationConfig/GateRulesSection.tsx': 1,
  'src/components/Moderation/GenerationConfig/GeneratorMessagesSection.tsx': 1,
  'src/components/MysteryBox/MysteryBoxCard.tsx': 2,
  'src/components/MysteryBox/MysteryBoxModal.tsx': 1,
  'src/components/Post/Batch/BatchComposer.tsx': 1,
  'src/components/Post/Batch/BatchPresets.tsx': 1,
  'src/components/Post/Detail/PostControls.tsx': 1,
  'src/components/Post/EditV2/PostEditSidebar.tsx': 1,
  'src/components/Post/EditV2/PostImageCards/AddedImage.tsx': 3,
  'src/components/Post/EditV2/PostImageDropzone.tsx': 1,
  'src/components/Profile/ProfileSectionsSettingsInput.tsx': 1,
  'src/components/Profile/UserContextMenu.tsx': 1,
  'src/components/PurchasableRewards/PurchasableRewards.tsx': 2,
  'src/components/RemixGallery/RemixGalleryCard.tsx': 4,
  'src/components/Resource/Forms/ModelUpsertForm.tsx': 1,
  'src/components/Resource/Forms/TrainingSelectFile.tsx': 1,
  'src/components/RichTextEditor/InsertEmbedControl.tsx': 1,
  'src/components/RichTextEditor/InsertTimestampControl.tsx': 1,
  'src/components/Shop/ShopItem.tsx': 2,
  'src/components/Storyline/AddToStorylineModal.tsx': 1,
  'src/components/Storyline/StartStorylineModal.tsx': 2,
  'src/components/Storyline/StorylineEndOfChapter.tsx': 1,
  'src/components/Storyline/StorylinesIntro.tsx': 1,
  'src/components/Storyline/manage/StorylineCoversRow.tsx': 1,
  'src/components/Stripe/GreenPurchaseAcknowledgement.tsx': 1,
  'src/components/Stripe/MembershipChangePrevention.tsx': 4,
  'src/components/Stripe/MembershipUpsell.tsx': 1,
  'src/components/Subscriptions/CancelMembershipAction.tsx': 1,
  'src/components/Subscriptions/PlanCard.tsx': 2,
  'src/components/Subscriptions/SubscriptionRequiredBlock.tsx': 1,
  'src/components/Training/Form/TrainingImages.tsx': 1,
  'src/components/Training/Form/TrainingImagesTagViewer.tsx': 1,
  'src/components/Vault/ToggleVaultButton.tsx': 2,
  'src/components/generation_v2/CompatibilityConfirmModal.tsx': 1,
  'src/components/generation_v2/DownloadBoostConfirm.tsx': 1,
  'src/components/generation_v2/inputs/ControlNetsInput.tsx': 1,
  'src/components/generation_v2/inputs/CustomDimensionsModal.tsx': 1,
  'src/components/generation_v2/preset/PresetControl.tsx': 1,
  'src/components/generation_v2/preset/PresetHeaderButton.tsx': 3,
  'src/pages/3d-models/[id]/reviews.tsx': 1,
  'src/pages/challenges/[id]/[[...slug]].tsx': 4,
  'src/pages/comics/create.tsx': 1,
  'src/pages/hubs/[id]/[[...slug]].tsx': 2,
  'src/pages/models/[id]/[[...slug]].tsx': 1,
  'src/pages/moderator/announcements.tsx': 1,
  'src/pages/moderator/buzz-withdrawal-requests.tsx': 1,
  'src/pages/moderator/code-gifts.tsx': 1,
  'src/pages/moderator/contests/bans.tsx': 1,
  'src/pages/moderator/cosmetic-store/products/index.tsx': 1,
  'src/pages/moderator/rewards-bonus-events.tsx': 1,
  'src/pages/services/[id]/[[...slug]].tsx': 1,
  'src/pages/user/vault.tsx': 3,
  'src/utils/comic-image-picker.ts': 1,
  'src/components/Account/UserPaymentConfigurationCard.tsx': 1,
};

function mantineModalsImports(sf: ts.SourceFile): number {
  return sf.statements.filter(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === '@mantine/modals'
  ).length;
}

function directDialogStoreOpens(sf: ts.SourceFile): number {
  let n = 0;
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    const name = memberName(callee);
    const object = memberObject(callee);
    if ((name === 'trigger' || name === 'toggle') && object && ts.isIdentifier(unwrap(object))) {
      if ((unwrap(object) as ts.Identifier).text === 'dialogStore') n++;
    }
  });
  return n;
}

function dialogContextVariables(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  walk(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isIdentifier(node.name)) return;
    const init = unwrap(node.initializer);
    if (
      ts.isCallExpression(init) &&
      ts.isIdentifier(init.expression) &&
      init.expression.text === 'useDialogContext'
    )
      names.add(node.name.text);
  });
  return names;
}

const DIALOG_SHELL = /^(Modal|Drawer)(\.Root)?$/;

function escapeViolations(sf: ts.SourceFile): number {
  const vars = dialogContextVariables(sf);
  if (!vars.size) return 0;
  let bad = 0;
  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    if (!DIALOG_SHELL.test(node.tagName.getText(sf))) return;
    const props = node.attributes.properties;
    const attribute = (name: string) =>
      props.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === name);
    const spreadsDialog = props.some(
      (p) =>
        ts.isJsxSpreadAttribute(p) && ts.isIdentifier(p.expression) && vars.has(p.expression.text)
    );
    const opened = attribute('opened')?.initializer?.getText(sf) ?? '';
    const openedFromDialog = [...vars].some((v) => opened === `{${v}.opened}`);
    if (!spreadsDialog && !openedFromDialog) return; // not the dialog's own shell
    const escape = attribute('closeOnEscape');
    if (!escape) {
      if (!spreadsDialog) bad++;
      return;
    }
    const value = escape.initializer?.getText(sf) ?? '{true}';
    if (value !== '{false}' && ![...vars].some((v) => value.includes(`${v}.closeOnEscape`))) bad++;
  });
  return bad;
}

describe('one way to open a dialog', () => {
  it('positive control: each check sees what it claims to', () => {
    const tsx = (src: string) => parse('x.tsx', src);
    expect(mantineModalsImports(tsx("import { openConfirmModal } from '@mantine/modals';"))).toBe(
      1
    );
    expect(mantineModalsImports(tsx("import { Modal } from '@mantine/core';"))).toBe(0);

    expect(
      directDialogStoreOpens(tsx('dialogStore.trigger({ component: X }); dialogStore.toggle(y);'))
    ).toBe(2);
    expect(
      directDialogStoreOpens(tsx('dialogStore.closeById(id); openDialog(() => import("x"));'))
    ).toBe(0);

    const dialog = (jsx: string) =>
      escapeViolations(tsx(`function D() { const dialog = useDialogContext(); return ${jsx}; }`));
    expect(dialog('<Modal {...dialog} title="t" />')).toBe(0);
    expect(dialog('<Modal {...dialog} closeOnEscape={!busy} />')).toBe(1);
    expect(dialog('<Modal {...dialog} closeOnEscape={dialog.closeOnEscape && !busy} />')).toBe(0);
    expect(dialog('<Modal {...dialog} closeOnEscape={false} />')).toBe(0);
    expect(dialog('<Modal opened={dialog.opened} onClose={dialog.onClose} />')).toBe(1);
    expect(dialog('<Drawer opened={dialog.opened} closeOnEscape={dialog.closeOnEscape} />')).toBe(
      0
    );
    expect(dialog('<Modal opened={localOpen} onClose={close} />')).toBe(0); // not the dialog's shell
  });

  const files = productionSources(SRC);

  it('nothing imports @mantine/modals', () => {
    expect(
      files.length,
      'the glob found no sources, so every check below would pass'
    ).toBeGreaterThan(1000);
    const found = countAll(files, '@mantine/modals', (sf) => mantineModalsImports(sf));
    expect(Object.keys(found), 'Use openConfirm / openContentDialog from Dialog/Common').toEqual(
      []
    );
  });

  const current = countAll(
    files.filter((f) => !DIALOG_CORE.test(f)),
    'dialogStore',
    (sf) => directDialogStoreOpens(sf)
  );
  const { grown, shrunk } = diffCounts(current, BASELINE);

  it('no file gains a direct dialogStore.trigger / toggle', () => {
    expect(grown, "Open the dialog with openDialog(() => import('…'), props) instead").toEqual([]);
  });

  it('the baseline matches the code (lower it when a call moves to openDialog)', () => {
    expect(
      shrunk,
      `Lower BASELINE in no-unlisted-dialog-open.test.ts:\n${formatBaseline(current)}`
    ).toEqual([]);
  });

  it("every dialog's Modal or Drawer takes closeOnEscape from the dialog", () => {
    const found = countAll(files, 'useDialogContext', (sf) => escapeViolations(sf));
    expect(
      Object.keys(found),
      'Spread the dialog context, or write closeOnEscape={dialog.closeOnEscape && …}, or false'
    ).toEqual([]);
  });
});
