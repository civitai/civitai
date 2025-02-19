import { adUnitFactory } from '~/components/Ads/AdUnitFactory';
import { useEffect } from 'react';
import { useAdUnitStore } from '~/components/Ads/adUnit.store';
import { useContainerLargerThan } from '~/components/ContainerProvider/useContainerLargerThan';
import { CloseButton } from '@mantine/core';

const AdUnit = adUnitFactory({
  adUnit: 'outstream',
  sizes: [[1, 1]],
  id: 'adngin-outstream-0',
  onDismount: () => {
    const scripts = document.querySelectorAll('script');
    scripts.forEach((script) => {
      if (script.src.includes('anyclip')) {
        script.remove();
      }
    });
    const allElements = document.body.getElementsByTagName('*');
    for (let i = allElements.length - 1; i >= 0; i--) {
      const element = allElements[i];
      if (
        element.innerHTML.includes('anyclip') ||
        Array.from(element.attributes).some((attr) => attr.value.includes('anyclip'))
      ) {
        element.remove();
      }
    }
  },
});

function EnableAdUnitOutstream() {
  useEffect(() => {
    useAdUnitStore.getState().enableAdUnit('outstream');
    return () => {
      useAdUnitStore.getState().disableAdUnit('outstream');
    };
  }, []);

  return null;
}

function AdUnitWithCloseButton() {
  const canClose = AdUnit.useImpressionTracked();
  return (
    <div className="flex flex-col items-end [&_iframe]:hidden">
      {canClose && <CloseButton />}
      <AdUnit />
    </div>
  );
}

export function AdUnitOutstream() {
  const enabled = useAdUnitStore((state) => state.adUnits.outstream);
  return enabled ? <AdUnitWithCloseButton /> : null;
}

export function RenderAdUnitOutstream({ minContainerWidth }: { minContainerWidth: number }) {
  const enabled = useContainerLargerThan(minContainerWidth);
  return enabled ? <EnableAdUnitOutstream /> : null;
}
