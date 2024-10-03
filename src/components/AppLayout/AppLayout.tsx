import React from 'react';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader, RenderSearchComponentProps } from '~/components/AppLayout/AppHeader';
import { AssistantButton } from '~/components/Assistant/AssistantButton';
import { FloatingActionButton2 } from '~/components/FloatingActionButton/FloatingActionButton';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

type AppLayoutProps = {
  innerLayout?: ({ children }: { children: React.ReactNode }) => React.ReactNode;
  withScrollArea?: boolean;
};

export function AppLayout({
  children,
  renderSearchComponent,
  withFooter = true,
}: {
  children: React.ReactNode;
  renderSearchComponent?: (opts: RenderSearchComponentProps) => React.ReactElement;
  withFooter?: boolean;
}) {
  const flags = useFeatureFlags();

  return (
    <>
      <AppHeader fixed={false} renderSearchComponent={renderSearchComponent} />
      <main className="relative flex size-full flex-1 flex-col overflow-hidden">
        {children}
        {/* {flags.assistant && (
              <div className={classes.assistant}>
                <AssistantButton />
              </div>
            )} */}

        <FloatingActionButton2 mounted={flags.assistant} transition="slide-up">
          <AssistantButton />
        </FloatingActionButton2>
      </main>
      {withFooter && <AppFooter fixed={false} />}
      {/* Disabling because this is popping in too frequently */}
      {/* <NewsletterDialog /> */}
    </>
  );
}

export function setPageOptions(Component: (...args: any) => JSX.Element, options?: AppLayoutProps) {
  (Component as any).options = options;
}
