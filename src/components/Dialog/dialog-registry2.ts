import dynamic from 'next/dynamic';
import type { ComponentProps, ComponentType } from 'react';

type DialogConfig<T> = {
  component: ComponentType<T>;
};
type DialogConfigDictionary<T extends Record<string, any>> = { [K in keyof T]: DialogConfig<T[K]> };

function dialogFactory<T extends Record<string, unknown>>(dictionary: DialogConfigDictionary<T>) {
  return dictionary;
}

export const dialogs = dialogFactory({
  'browsing-level-guide': {
    component: dynamic(() => import('~/components/BrowsingLevel/BrowsingLevelGuide')),
  },
  'browsing-level-update': {
    component: dynamic(() => import('~/components/BrowsingLevel/SetBrowsingLevelModal')),
  },
  'feature-introduction': {
    component: dynamic(() => import('~/components/FeatureIntroduction/FeatureIntroduction')),
  },
  'hidden-tags': {
    component: dynamic(() => import('~/components/Tags/HiddenTagsModal')),
  },
  'resource-select': {
    component: dynamic(
      () => import('~/components/ImageGeneration/GenerationForm/ResourceSelectModal2')
    ),
  },
  'collection-select': {
    component: dynamic(() => import('~/components/CollectionSelectModal/CollectionSelectModal')),
  },
  'model-migrate-to-collection': {
    component: dynamic(() => import('~/components/Model/Actions/MigrateModelToCollection')),
  },
  'model-gallery-moderation': {
    component: dynamic(() =>
      import('~/components/Image/AsPosts/GalleryModerationModal').then(
        (x) => x.GalleryModerationModal
      )
    ),
  },
  alert: {
    component: dynamic(() => import('~/components/Dialog/Common/AlertDialog')),
  },
  confirm: {
    component: dynamic(() => import('~/components/Dialog/Common/ConfirmDialog')),
  },
  'paddle-transaction': {
    component: dynamic(() => import('~/components/Paddle/PaddleTransacionModal')),
  },
  'redeem-code': {
    component: dynamic(() =>
      import('~/components/RedeemableCode/RedeemCodeModal').then((x) => x.RedeemCodeModal)
    ),
  },
  'buzz-create-withdrawal-request': {
    component: dynamic(() =>
      import('~/components/Buzz/WithdrawalRequest/CreateWithdrawalRequest').then(
        (x) => x.CreateWithdrawalRequest
      )
    ),
  },
  'collection-edit': {
    component: dynamic(() => import('~/components/Collections/CollectionEditModal')),
  },
  'cosmetic-shop-item-preview': {
    component: dynamic(() =>
      import('~/components/CosmeticShop/CosmeticShopItemPreviewModal').then(
        (x) => x.CosmeticShopItemPreviewModal
      )
    ),
  },
  'cosmetic-shop-item-purchase-complete': {
    component: dynamic(() =>
      import('~/components/CosmeticShop/CosmeticShopItemPreviewModal').then(
        (x) => x.CosmeticShopItemPurchaseCompleteModal
      )
    ),
  },
  'card-decoration': {
    component: dynamic(() => import('~/components/Modals/CardDecorationModal')),
  },
  'crucible-submit-entry': {
    component: dynamic(() => import('~/components/Crucible/CrucibleSubmitEntryModal')),
  },
});

export type DialogRegistry = typeof dialogs;

type DialogProps<TKey extends keyof DialogRegistry> = ComponentProps<
  DialogRegistry[TKey]['component']
> extends Record<string, never>
  ? { props?: ComponentProps<DialogRegistry[TKey]['component']> }
  : { props: Prettify<ComponentProps<DialogRegistry[TKey]['component']>> };

type DialogSettings<TKey extends keyof DialogRegistry> = {
  id?: string | number | symbol;
  name: TKey;
  type?: 'dialog' | 'routed-dialog';
  target?: string | HTMLElement;
  options?: {
    transitionDuration?: number;
    onClose?: () => void;
  };
} & DialogProps<TKey>;

export type Dialog<TKey extends keyof DialogRegistry> = DialogSettings<TKey> & {
  id: string | number | symbol;
};

function trigger<TKey extends keyof DialogRegistry>(args: DialogSettings<TKey>) {
  return args;
}

const test = trigger({ name: 'feature-introduction', props: { feature: '' } });
const test2 = trigger({ name: 'hidden-tags' });

// const test3 = trigger({ name: 'cosmetic-shop-item-preview', props: {} });

// const test3 = trigger({ name: 'confirm', props: {} });
