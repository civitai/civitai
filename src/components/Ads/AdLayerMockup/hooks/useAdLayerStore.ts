import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AdBlock, AdLayerState, MAX_AD_BLOCKS } from '../types';
import { getDefaultAdLayout, generateMockAd } from '../utils/mockAdData';
import { updatePosition, recalculatePositions, getDefaultPosition } from '../utils/positionUtils';

interface AdLayerStore extends AdLayerState {
  updateBlockPosition: (id: string, pixelX: number, pixelY: number) => void;
  toggleMinimize: (id: string) => void;
  removeBlock: (id: string) => void;
  addBlock: (type: AdBlock['type']) => void;
  resetLayout: () => void;
  toggleEditMode: () => void;
  toggleGrid: () => void;
  togglePanel: () => void;
  bringToFront: (id: string) => void;
  handleResize: () => void;
  rotateAd: (id: string) => void;
}

const useAdLayerStore = create<AdLayerStore>()(
  persist(
    (set, get) => ({
      blocks: getDefaultAdLayout(),
      isEditMode: false,
      showGrid: false,
      isPanelOpen: false,
      lastSaved: new Date().toISOString(),

      updateBlockPosition: (id, pixelX, pixelY) =>
        set((state) => ({
          blocks: state.blocks.map((block) => {
            if (block.id !== id) return block;
            
            const size = block.minimized 
              ? { width: 200, height: 40 } 
              : block.size;
            
            const position = updatePosition(pixelX, pixelY, size);
            
            return { ...block, position };
          }),
          lastSaved: new Date().toISOString(),
        })),

      toggleMinimize: (id) =>
        set((state) => ({
          blocks: state.blocks.map((block) => {
            if (block.id !== id) return block;
            
            const minimized = !block.minimized;
            const size = minimized 
              ? { width: 200, height: 40 } 
              : block.size;
            
            // Recalculate position to ensure it stays in bounds when size changes
            const position = updatePosition(
              block.position.x, 
              block.position.y, 
              size
            );
            
            return { ...block, minimized, position };
          }),
          lastSaved: new Date().toISOString(),
        })),

      removeBlock: (id) =>
        set((state) => ({
          blocks: state.blocks.filter((block) => block.id !== id),
          lastSaved: new Date().toISOString(),
        })),

      addBlock: (type) => {
        const state = get();
        if (state.blocks.length >= MAX_AD_BLOCKS) {
          alert(`Maximum of ${MAX_AD_BLOCKS} ad blocks allowed`);
          return;
        }

        const mockAd = generateMockAd(type, state.blocks.length);
        const position = getDefaultPosition(state.blocks.length, mockAd.size);

        const newBlock: AdBlock = {
          ...mockAd,
          position,
          rotationCount: 0,
          currentAdIndex: 0,
        };

        set((state) => ({
          blocks: [...state.blocks, newBlock],
          lastSaved: new Date().toISOString(),
        }));
      },

      resetLayout: () =>
        set({
          blocks: getDefaultAdLayout(),
          lastSaved: new Date().toISOString(),
        }),

      toggleEditMode: () =>
        set((state) => ({
          isEditMode: !state.isEditMode,
          showGrid: !state.isEditMode,
        })),

      toggleGrid: () =>
        set((state) => ({
          showGrid: !state.showGrid,
        })),

      togglePanel: () =>
        set((state) => ({
          isPanelOpen: !state.isPanelOpen,
        })),

      bringToFront: (id) =>
        set((state) => {
          const maxZ = Math.max(...state.blocks.map((b) => b.zIndex));
          return {
            blocks: state.blocks.map((block) =>
              block.id === id ? { ...block, zIndex: maxZ + 1 } : block
            ),
          };
        }),
        
      handleResize: () =>
        set((state) => ({
          blocks: recalculatePositions(state.blocks),
          lastSaved: new Date().toISOString(),
        })),

      rotateAd: (id) =>
        set((state) => ({
          blocks: state.blocks.map((block) => {
            if (block.id !== id) return block;
            
            const rotationCount = (block.rotationCount || 0) + 1;
            const currentAdIndex = ((block.currentAdIndex || 0) + 1) % 10; // Cycle through 10 different ad variations
            const lastRotation = Date.now();
            
            return { 
              ...block, 
              rotationCount,
              currentAdIndex,
              lastRotation,
            };
          }),
          lastSaved: new Date().toISOString(),
        })),
    }),
    {
      name: 'ad-layer-mockup',
    }
  )
);

export default useAdLayerStore;