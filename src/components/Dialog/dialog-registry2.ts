import dynamic from 'next/dynamic';
import { ComponentProps } from 'react';

export type DialogRegistry = typeof dialogs;

export const dialogs = {
  'feature-introduction-modal': dynamic(
    () => import('~/components/FeatureIntroduction/FeatureIntroduction')
  ),
  'hidden-tags-modal': dynamic(() => import('~/components/Tags/HiddenTagsModal')),
};

type DialogProps<TKey extends keyof DialogRegistry> = ComponentProps<
  DialogRegistry[TKey]
> extends Record<string, never>
  ? { props?: ComponentProps<DialogRegistry[TKey]> }
  : { props: ComponentProps<DialogRegistry[TKey]> };

type DialogSettings<TKey extends keyof DialogRegistry> = {
  id?: string | number | symbol;
  component: TKey;
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

// const test = trigger({
//   component: 'feature-introduction-modal',
//   props: { feature: '' },
// });

// const test2 = trigger({
//   component: 'hidden-tags-modal',
// });
