import { nprogress, NavigationProgress } from '@mantine/nprogress';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

export function RouterTransition() {
  useIsChangingLocation();

  return (
    // 🔴 `@mantine/nprogress`'s bar is `position: fixed; top: 0` in its own
    // stylesheet (`.m_8f2832ae`, `@mantine/nprogress/styles.layer.css`) and is
    // portaled to `<body>`, so `#__next`'s `padding-top` cannot reach it. It is
    // 3px tall by default — entirely inside the 47–59px cutout strip once
    // `viewport-fit=cover` extends the layout viewport under the notch — and
    // `_app.tsx` renders this component on EVERY route, so unpaid it means
    // page-load progress is simply invisible on a notched phone in portrait.
    //
    // 🔴 PAID HERE AND NOT AT THE `@layer mantine` SEAM IN globals.css, unlike
    // every other node_modules surface. `NavigationProgress` renders a
    // `<Progress>` internally, so its static class is `mantine-Progress-root` —
    // shared with every ordinary progress bar in the app. There is no selector
    // that means "the navigation progress bar" and is not a content hash, and
    // there is exactly ONE call site, so the call site is the honest place.
    // 🔴 A `className`, NOT `style` — and that is a type fact, not taste.
    // `NavigationProgressProps extends ElementProps<'div'>`, and Mantine's
    // `ElementProps` OMITS `style` (its components normally take it via
    // `BoxProps`, which this one does not extend). So `style` is a compile
    // error here even though `...others` would forward it fine at runtime;
    // `className` is in the type and reaches the `Progress` root the same way.
    // The Tailwind arbitrary utility is UNLAYERED, so it beats the stylesheet's
    // `top: 0` in `@layer mantine` whatever the specificity, with no
    // `!important`. Collapses to `top: 0px` on any device without a cutout.
    <NavigationProgress
      aria-label="Page loading progress"
      className="top-[var(--safe-area-inset-top)]"
    />
  );
}

export const useIsChangingLocation = () => {
  const router = useRouter();
  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    const handleStart = (url: string) => {
      if (url !== router.asPath) {
        setIsTransitioning(true);
        nprogress.start();
      }
    };
    const handleComplete = () => {
      setIsTransitioning(false);
      nprogress.complete();
    };

    router.events.on('routeChangeStart', handleStart);
    router.events.on('routeChangeComplete', handleComplete);
    router.events.on('routeChangeError', handleComplete);

    return () => {
      router.events.off('routeChangeStart', handleStart);
      router.events.off('routeChangeComplete', handleComplete);
      router.events.off('routeChangeError', handleComplete);
    };
  }, [router.asPath, router.events]);

  return isTransitioning;
};
