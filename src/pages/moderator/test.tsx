import { Box, Button, useMantineTheme } from '@mantine/core';
import React, { Key, createContext, useContext, useEffect, useRef, useState } from 'react';
import { TypeOf, ZodAny, ZodArray, ZodEffects, ZodObject, ZodString, ZodTypeAny, z } from 'zod';
import { StoreApi, createStore } from 'zustand';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
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
      <></>
    </IsClient>
  );
}
