import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useTipStore = create<{ civitaiTip: number; creatorTip: number }>()(
  persist(() => ({ civitaiTip: 0, creatorTip: 0.25 }), { name: 'tips' })
);
