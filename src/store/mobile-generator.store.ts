import { create } from 'zustand';

export const useMobileGeneratorStore = create<{
  /** The mobile generator is on screen, so the dialogs above it take a Back step each. */
  showing: boolean;
  /** When the last generation was submitted; the mobile generator closes its form on it. */
  submittedAt: number;
}>(() => ({ showing: false, submittedAt: 0 }));
