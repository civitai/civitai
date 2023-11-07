import dynamic from 'next/dynamic';
import { ComponentProps, ComponentType } from 'react';
import { UrlObject } from 'url';

const ImageDetailModal = dynamic(() => import('~/components/Image/Detail/ImageDetailModal'));

type Url = UrlObject | string;
type DialogItem<T> = {
  component: ComponentType<T>;
  resolve: (
    query: Record<string, string | string[]>,
    args: ComponentProps<ComponentType<T>>
  ) => { url: Url; asPath?: Url; state?: Record<string, unknown> };
};
type DialogRegistry<T> = { [K in keyof T]: DialogItem<T[K]> };

function createDialogDictionary<T>(dictionary: DialogRegistry<T>): DialogRegistry<T> {
  return dictionary;
}

export const dialogs = createDialogDictionary({
  imageDetail: {
    component: ImageDetailModal,
    resolve: (query, { imageId, ...state }) => ({
      url: { query: { ...query, imageId } },
      asPath: `/images/${imageId}`,
      state,
    }),
  },
});
