import { FeatureFlags, getFeatureFlags } from '~/server/services/feature-flags.service';
import { createContext } from 'react';

const FeatureFlagsCtx = createContext<FeatureFlags>({} as FeatureFlags);
