import type { PlannerHost, PlannerLocation, PlannerPost } from '../host.js';
import type { Filters } from '../model/posts.js';

/** Every state change a view or part can ask the element for. Render functions never hold the element. */
export interface PlannerActions {
  navigate(loc: PlannerLocation): void;
  /** An anchor click that stays in the host unless a modifier asks for a new tab. */
  link(event: Event, loc: PlannerLocation): void;
  setFilters(filters: Partial<Filters>): void;
  setShowMature(value: boolean): void;
  toggleSelectMode(): void;
  clearSelection(): void;
  toggleSelected(id: number): void;
  toggleUnblur(id: number): void;
  open(post: PlannerPost, at?: Date): void;
  close(): void;
  setDraft(date: string | null, time: string | null): void;
  toggleDescription(): void;
  setLightbox(index: number | null): void;
  reschedule(post: PlannerPost, when: Date): void;
  publishNow(post: PlannerPost): void;
  unschedule(ids: number[]): void;
  shiftSelected(deltaMinutes: number): void;
  undoMove(): void;
  rowAction(post: PlannerPost, action: string): void;
  onChipKey(post: PlannerPost, event: KeyboardEvent): void;
  onDrawerKey(event: KeyboardEvent): void;
  onDragStart(post: PlannerPost, event: DragEvent): void;
  onDragEnd(): void;
  onDragOver(dayKey: string, event: DragEvent): void;
  onDragLeave(dayKey: string): void;
  onDrop(dayKey: string, event: DragEvent): void;
}

export interface PostContext {
  host: PlannerHost;
  selectMode: boolean;
  selectedIds: ReadonlySet<number>;
  pending: ReadonlySet<number>;
  dragId: number | null;
  isScheduled(post: PlannerPost): boolean;
  isBlurred(item: { id: number; nsfwLevel: number }): boolean;
  actions: PlannerActions;
}
