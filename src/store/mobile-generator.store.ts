import { create } from 'zustand';

export const useMobileGeneratorStore = create<{
  /** The mobile generator is on screen. */
  showing: boolean;
  /** When the last generation was submitted; the mobile generator closes its form on it. */
  submittedAt: number;
}>(() => ({ showing: false, submittedAt: 0 }));
