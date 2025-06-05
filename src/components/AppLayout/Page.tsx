import type { NextPage } from 'next';
import type { UseFeatureFlagsReturn } from '~/providers/FeatureFlagsProvider';

type PageOptions = {
  getLayout?: (page: React.ReactElement) => JSX.Element;
  InnerLayout?: (page: { children: React.ReactElement }) => JSX.Element;
  features?: (features: UseFeatureFlagsReturn) => boolean;
  subNav?: React.ReactNode | null;
  left?: React.ReactNode;
  right?: React.ReactNode;
  main?: React.ReactNode;
  scrollable?: boolean;
  footer?: React.ReactNode | null;
  announcements?: boolean;
  browsingLevel?: number;
};

export type CustomNextPage = NextPage<any> & PageOptions;

export function Page(Component: CustomNextPage, options?: PageOptions) {
  Component.getLayout = options?.getLayout;
  Component.InnerLayout = options?.InnerLayout;
  Component.features = options?.features;
  Component.subNav = options?.subNav;
  Component.left = options?.left;
  Component.right = options?.right;
  Component.main = options?.main;
  Component.scrollable = options?.scrollable;
  Component.footer = options?.footer;
  Component.announcements = options?.announcements;
  Component.browsingLevel = options?.browsingLevel;

  return Component;
}
