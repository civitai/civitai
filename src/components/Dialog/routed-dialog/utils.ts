import type { ComponentProps, ComponentType } from 'react';
import type { UrlObject } from 'url';

type Url = UrlObject | string;

export type DialogItem<T> = {
  requireAuth?: boolean;
  component: ComponentType<T>;
  target?: string;
  resolve: (
    query: Record<string, unknown>,
    args: ComponentProps<ComponentType<T>>
  ) => { query: Record<string, unknown>; asPath?: Url; state?: Record<string, unknown> | any };
};

function createRoutedDialogDictionary() {
  const items: Record<string, DialogItem<any>> = {};

  return {
    addItem<TName extends string, TItem extends DialogItem<any>>(name: TName, item: TItem) {
      items[name] = item;
      return { [name]: item } as Record<TName, TItem>;
    },
    getItems<T extends Record<string, DialogItem<any>>>() {
      return items as T;
    },
  };
}

export const routedDialogDictionary = createRoutedDialogDictionary();
