import { NextPage } from 'next';
import React, { ReactElement } from 'react';
import { UseFeatureFlagsReturn } from '~/providers/FeatureFlagsProvider';

export type InnerLayoutOptions = {
  InnerLayout?: (page: { children: React.ReactElement }) => JSX.Element;
  withScrollArea?: boolean;
  withFooter?: boolean;
  innerLayout?: (page: { children: React.ReactNode }) => JSX.Element; // this needs to go away
};

export type OuterLayoutOptions = {
  layout: (page: { children: React.ReactNode }) => JSX.Element;
};
type BaseOptions = {
  features?: (features: UseFeatureFlagsReturn) => boolean;
};
type CreatePageOptions = (InnerLayoutOptions | OuterLayoutOptions) & BaseOptions;

export type CustomNextPage = NextPage & {
  getLayout?: (page: ReactElement) => JSX.Element;
  options?: InnerLayoutOptions & BaseOptions;
};

export function createPage(Component: CustomNextPage, options?: CreatePageOptions) {
  if (options) {
    if ('layout' in options) {
      const Elem = options.layout;
      Component.getLayout = (page: ReactElement) => <Elem>{page}</Elem>;
    } else {
      Component.options = options;
    }
  }

  return Component;
}
