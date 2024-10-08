import { NextPage } from 'next';
import { UseFeatureFlagsReturn } from '~/providers/FeatureFlagsProvider';

type PageOptions = {
  getLayout?: (page: React.ReactElement) => JSX.Element;
  InnerLayout?: (page: { children: React.ReactElement }) => JSX.Element;
  features?: (features: UseFeatureFlagsReturn) => boolean;
  subNav?: React.ReactNode | null;
  left?: React.ReactNode;
  right?: React.ReactNode;
};

export type CustomNextPage = NextPage & PageOptions;

export function Page(Component: CustomNextPage, options?: PageOptions) {
  Component.getLayout = options?.getLayout;
  Component.InnerLayout = options?.InnerLayout;
  Component.features = options?.features;
  Component.subNav = options?.subNav;
  Component.left = options?.left;
  Component.right = options?.right;

  return Component;
}
