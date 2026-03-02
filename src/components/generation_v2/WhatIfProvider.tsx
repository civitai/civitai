/**
 * WhatIfProvider
 *
 * Provider that exposes whatIf (cost estimation) data to child components.
 * Uses the data-graph based whatIf hook internally.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { useWhatIfFromGraph } from './hooks/useWhatIfFromGraph';

// =============================================================================
// Types
// =============================================================================

type WhatIfContextValue = ReturnType<typeof useWhatIfFromGraph>;

// =============================================================================
// Context
// =============================================================================

const WhatIfContext = createContext<WhatIfContextValue | null>(null);

// =============================================================================
// Hook
// =============================================================================

/**
 * Access the whatIf data from the nearest WhatIfProvider.
 * Must be used within a WhatIfProvider.
 */
export function useWhatIfContext() {
  const context = useContext(WhatIfContext);
  if (!context) {
    throw new Error('useWhatIfContext must be used within a WhatIfProvider');
  }
  return context;
}

// =============================================================================
// Provider Component
// =============================================================================

export interface WhatIfProviderProps {
  children: ReactNode;
  /** Whether to enable the whatIf query (default: true) */
  enabled?: boolean;
}

/**
 * Provides whatIf (cost estimation) data to child components.
 * Must be nested inside a DataGraphProvider (typically via GenerationFormProvider).
 */
export function WhatIfProvider({ children, enabled = true }: WhatIfProviderProps) {
  const whatIf = useWhatIfFromGraph({ enabled });

  return <WhatIfContext.Provider value={whatIf}>{children}</WhatIfContext.Provider>;
}
