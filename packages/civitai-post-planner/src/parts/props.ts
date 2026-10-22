import type { PlannerHost, PlannerLocation, PlannerPost } from '../host';
import type { ShiftDraft } from '../model/bulk';
import type { Filters } from '../model/posts';

/** Every state change a view or part can ask the element for. Render functions never hold the element. */
export interface PlannerActions {
  navigate(loc: PlannerLocation): void;
  /** An anchor click that stays in the host unless a modifier asks for a new tab. */
  link(event: Event, loc: PlannerLocation): void;
  setFilters(filters: Partial<Filters>): void;
  /** Filters the calendar to posts carrying `tag`; `undefined` clears it. Rides in the location. */
  setTag(tag: string | undefined): void;
  toggleFilters(): void;
  setShowMature(value: boolean): void;
  toggleAllHours(): void;
  toggleSelectMode(): void;
  clearSelection(): void;
  /** Selects every selectable post the current view and filters show. */
  selectAll(): void;
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
  openShiftDialog(): void;
  setShiftDraft(draft: Partial<ShiftDraft>): void;
  applyShift(): void;
  openMoveDialog(): void;
  setMoveDay(dayKey: string): void;
  applyMoveToDay(): void;
  closeDialog(): void;
  undoMove(): void;
  rowAction(post: PlannerPost, action: string): void;
  onChipKey(post: PlannerPost, event: KeyboardEvent): void;
  onDrawerKey(event: KeyboardEvent): void;
  onDragStart(post: PlannerPost, event: DragEvent): void;
  onDragEnd(): void;
  onDragOver(dayKey: string, event: DragEvent): void;
  /** An hour-grid column reports the snapped instant under the pointer as well as the day. */
  onDragOverAt(dayKey: string, when: Date, event: DragEvent): void;
  onDragLeave(dayKey: string): void;
  onDrop(dayKey: string, event: DragEvent): void;
  onDropAt(when: Date, event: DragEvent): void;
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
