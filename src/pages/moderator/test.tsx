import { Box, Button, useMantineTheme } from '@mantine/core';
import React, { Key, createContext, useContext, useEffect, useRef, useState } from 'react';
import { TypeOf, ZodAny, ZodArray, ZodEffects, ZodObject, ZodString, ZodTypeAny, z } from 'zod';
import { StoreApi, createStore } from 'zustand';
import { Adunit } from '~/components/Ads/AdUnit';
import { GenerationForm2 } from '~/components/ImageGeneration/GenerationForm/GenerationForm2';
import { GenerationFormProvider } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import {
  IntersectionObserverProvider,
  useIntersectionObserverContext,
} from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { IsClient } from '~/components/IsClient/IsClient';
import OnboardingWizard from '~/components/Onboarding/OnboardingWizard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form } from '~/libs/form';
import { Watch } from '~/libs/form/components/Watch';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import { getRandomInt } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const array = new Array(100).fill(0).map(() => getRandomInt(100, 400));

export default function Test() {
  return (
    <IsClient>
      <>
        <IntersectionObserverProvider
          id="test_list"
          className="container flex max-w-xs flex-col gap-3"
        >
          {array.map((height, i) => (
            <InnerContent key={i} height={height} index={i} />
          ))}
        </IntersectionObserverProvider>
      </>
    </IsClient>
  );
}

function InnerContent({ height, index }: { height: number; index: number }) {
  // const { ref } = useTest();
  const { ref, inView } = useIntersectionObserverContext({ id: index.toString() });

  return (
    <div ref={ref} className="w-full p-3 card">
      {inView && <div className="size-full bg-red-200" style={{ height }}></div>}
    </div>
  );
}
