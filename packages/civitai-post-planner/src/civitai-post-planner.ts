import '@civitai/components/register';
import { CivitaiElement } from '@civitai/components/internals';
import type { CivitaiConfirmDialog } from '@civitai/components/civitai-confirm-dialog';
import type { CivitaiToastRegion } from '@civitai/components/civitai-toast-region';
import { getPostScheduleError } from '@civitai/shared/post-scheduling';
import {
  html,
  nothing,
  type PropertyDeclarations,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import type {
  MoveResult,
  PlannerEventMap,
  PlannerHost,
  PlannerLocation,
  PlannerPost,
  PlannerPostDetail,
  PlannerScope,
  ScheduledRange,
} from './host.js';
import {
  defaultView,
  formatDateTime,
  localDayKey,
  mergeDraftInput,
  moveToDay,
  snapToFiveMinutes,
  visibleRange,
} from './model/calendar.js';
import {
  messageOf,
  releaseScopeLabel,
  shiftedMessage,
  unscheduledMessage,
} from './model/messages.js';
import {
  applyOverrides,
  countScheduled,
  countScheduledOn,
  drawerPost,
  type Filters,
  hasMature,
  isScheduled,
  modelFilterOptions,
  neighbours,
  type Override,
  scopeOf,
  visiblePosts,
} from './model/posts.js';
import { bulkBarStyles, renderBulkBar } from './parts/bulk-bar.js';
import { chipStyles } from './parts/chip.js';
import { drawerStyles, renderDrawer } from './parts/drawer.js';
import { headerStyles, renderHeader } from './parts/header.js';
import { legendStyles, renderLegend } from './parts/legend.js';
import { lightboxStyles } from './parts/lightbox.js';
import { shouldBlur } from './parts/media.js';
import { mediaStripStyles } from './parts/media-strip.js';
import { noticeStyles, renderNotice, renderTruncatedNotice, renderUndo } from './parts/notices.js';
import type { PlannerActions, PostContext } from './parts/props.js';
import { rowStyles } from './parts/row.js';
import { renderToolbar, toolbarStyles } from './parts/toolbar.js';
import { baseStyles } from './styles.js';
import { renderView, viewStyles } from './views/index.js';
import { listStyles } from './views/list.js';
import { monthStyles } from './views/month.js';

const UNDO_WINDOW_MS = 8_000;
const SHOW_MATURE_KEY = 'civitai-post-planner:show-mature';

type Undo = { id: number; from: string; expectedScope: PlannerScope; until: number };

export class CivitaiPostPlanner extends CivitaiElement {
  static override styles = [
    baseStyles,
    headerStyles,
    toolbarStyles,
    legendStyles,
    noticeStyles,
    viewStyles,
    monthStyles,
    chipStyles,
    listStyles,
    rowStyles,
    drawerStyles,
    mediaStripStyles,
    lightboxStyles,
    bulkBarStyles,
  ];

  static override properties: PropertyDeclarations = {
    host: { attribute: false },
    location: { attribute: false },
    _range: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _selectedId: { state: true },
    _detail: { state: true },
    _detailLoading: { state: true },
    _draftWhen: { state: true },
    _descriptionExpanded: { state: true },
    _showMature: { state: true },
    _unblurred: { state: true },
    _filters: { state: true },
    _selectMode: { state: true },
    _selectedIds: { state: true },
    _dragId: { state: true },
    _dragOver: { state: true },
    _pending: { state: true },
    _overrides: { state: true },
    _undo: { state: true },
    _now: { state: true },
    _narrow: { state: true },
    _lightbox: { state: true },
    _announcement: { state: true },
  };

  declare host?: PlannerHost;
  declare location?: PlannerLocation;

  declare _range: ScheduledRange | null;
  declare _loading: boolean;
  declare _error: string | null;
  declare _selectedId: number | null;
  declare _detail: PlannerPostDetail | null;
  declare _detailLoading: boolean;
  declare _draftWhen: Date | null;
  declare _descriptionExpanded: boolean;
  declare _showMature: boolean;
  declare _unblurred: Set<number>;
  declare _filters: Filters;
  declare _selectMode: boolean;
  declare _selectedIds: Set<number>;
  declare _dragId: number | null;
  declare _dragOver: string | null;
  declare _pending: Set<number>;
  declare _overrides: Map<number, Override>;
  declare _undo: Undo | null;
  declare _now: Date;
  declare _narrow: boolean;
  declare _lightbox: number | null;
  declare _announcement: string;

  #loadToken = 0;
  #detailToken = 0;
  #tick?: ReturnType<typeof setInterval>;
  #undoTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    super();
    this._range = null;
    this._loading = false;
    this._error = null;
    this._selectedId = null;
    this._detail = null;
    this._detailLoading = false;
    this._draftWhen = null;
    this._descriptionExpanded = false;
    this._showMature = false;
    this._unblurred = new Set();
    this._filters = { scheduled: true, published: false, releases: true };
    this._selectMode = false;
    this._selectedIds = new Set();
    this._dragId = null;
    this._dragOver = null;
    this._pending = new Set();
    this._overrides = new Map();
    this._undo = null;
    this._now = new Date();
    this._narrow = false;
    this._lightbox = null;
    this._announcement = '';
  }

  #onLightboxKey = (event: KeyboardEvent) => {
    const detail = this._detail;
    if (this._lightbox == null || !detail) return;
    const count = detail.media.length;
    if (event.key === 'ArrowRight') this._lightbox = (this._lightbox + 1) % count;
    else if (event.key === 'ArrowLeft') this._lightbox = (this._lightbox - 1 + count) % count;
    else return;
    event.preventDefault();
  };

  #narrowQuery?: MediaQueryList;
  #onNarrowChange = (event: MediaQueryListEvent | MediaQueryList) => {
    this._narrow = event.matches;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.#tick = setInterval(() => (this._now = new Date()), 30_000);
    this.#narrowQuery = window.matchMedia('(max-width: 767px)');
    this.#onNarrowChange(this.#narrowQuery);
    this.#narrowQuery.addEventListener('change', this.#onNarrowChange);
    if (this._lightbox != null) window.addEventListener('keydown', this.#onLightboxKey);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.#tick) clearInterval(this.#tick);
    if (this.#undoTimer) clearTimeout(this.#undoTimer);
    this._undo = null;
    this.#narrowQuery?.removeEventListener('change', this.#onNarrowChange);
    window.removeEventListener('keydown', this.#onLightboxKey);
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('host') && this.host) {
      this.#loadToken++;
      this.#detailToken++;
      this._showMature =
        readStoredShowMature(this.host.config.userId) ?? this.host.config.showMature ?? false;
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has('host') || changed.has('location')) void this.#load();
    if (changed.has('_range') || changed.has('_selectedId')) this.#syncDetail();
    if (changed.has('_lightbox')) {
      if (this._lightbox != null) window.addEventListener('keydown', this.#onLightboxKey);
      else window.removeEventListener('keydown', this.#onLightboxKey);
    }
  }

  get #loc(): PlannerLocation {
    return this.location ?? { view: 'month', anchor: localDayKey(this._now) };
  }

  get #today(): string {
    return localDayKey(this._now);
  }

  get #posts(): PlannerPost[] {
    return applyOverrides(this._range?.posts ?? [], this._overrides);
  }

  get #visiblePosts(): PlannerPost[] {
    return visiblePosts(this.#posts, this._filters, this._now, this.#loc.modelVersionId);
  }

  #isScheduled = (post: PlannerPost): boolean => isScheduled(post, this._now);

  #isBlurred = (item: { id: number; nsfwLevel: number }): boolean => {
    const level = this.host?.config.browsingLevel ?? 0;
    return shouldBlur(item.nsfwLevel, level, this._showMature, this._unblurred.has(item.id));
  };

  async #load(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const token = ++this.#loadToken;
    const loc = this.#loc;
    const { from, to } = visibleRange(loc.view, loc.anchor);
    this._loading = true;
    this._error = null;
    try {
      const range = await host.backend.getScheduled({
        from: from.toISOString(),
        to: to.toISOString(),
        modelVersionId: loc.modelVersionId,
      });
      if (token !== this.#loadToken) return;
      this._range = range;
      // Server state now carries every confirmed move; keep an override only while the reload
      // still shows the date it replaced (a replica can lag the write).
      const kept = new Map<number, Override>();
      for (const post of range.posts) {
        const override = this._overrides.get(post.id);
        if (override && override.from === post.publishedAt) kept.set(post.id, override);
      }
      this._overrides = kept;
      if (!this.location) {
        const view = defaultView(range.posts, this._now, { narrow: this._narrow });
        if (view !== loc.view) this.#navigate({ ...loc, view });
      }
    } catch (error) {
      if (token !== this.#loadToken) return;
      this._error = messageOf(error, 'Could not load your scheduled posts.');
    } finally {
      if (token === this.#loadToken) this._loading = false;
    }
  }

  #syncDetail(): void {
    const id = this._selectedId;
    if (id == null) {
      this._detail = null;
      return;
    }
    if (this._detail?.id === id) return;
    const host = this.host;
    if (!host) return;
    const token = ++this.#detailToken;
    this._detailLoading = true;
    host.backend
      .getPostDetail(id)
      .then((detail) => {
        if (token !== this.#detailToken) return;
        this._detail = detail;
      })
      .catch((error) => {
        if (token !== this.#detailToken) return;
        this.#toast(messageOf(error, 'Could not load that post.'), 'error');
      })
      .finally(() => {
        if (token === this.#detailToken) this._detailLoading = false;
      });
  }

  #navigate(loc: PlannerLocation): void {
    this.#emit('navigate', loc);
    void this.host?.navigate(loc);
  }

  #opener: HTMLElement | null = null;

  #open(post: PlannerPost, at?: Date): void {
    if (this._selectedId !== post.id) {
      const active = this.shadowRoot?.activeElement;
      this.#opener = active instanceof HTMLElement ? active : null;
    }
    this._selectedId = post.id;
    this._descriptionExpanded = false;
    this._draftWhen = at ?? new Date(post.publishedAt);
    this._lightbox = null;
    void this.updateComplete.then(() =>
      this.renderRoot.querySelector<HTMLElement>('.drawer [aria-label="Close"]')?.focus()
    );
  }

  #close(): void {
    this._selectedId = null;
    this._draftWhen = null;
    this._lightbox = null;
    const opener = this.#opener;
    this.#opener = null;
    if (opener?.isConnected) opener.focus();
  }

  #onDrawerKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this._selectedId != null && this._lightbox == null) {
      event.preventDefault();
      this.#close();
    }
  };

  #setShowMature(value: boolean): void {
    this._showMature = value;
    try {
      localStorage.setItem(showMatureKey(this.host?.config.userId), value ? '1' : '0');
    } catch {
      // Private mode or blocked storage: the toggle still works for this page.
    }
    this.#emit('show-mature-change', { showMature: value });
  }

  #toggleUnblur(id: number): void {
    const next = new Set(this._unblurred);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this._unblurred = next;
  }

  #toggleSelected(id: number): void {
    const post = this.#posts.find((p) => p.id === id);
    if (!post || post.release || !this.#isScheduled(post)) return;
    const next = new Set(this._selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this._selectedIds = next;
  }

  async #reschedule(post: PlannerPost, when: Date, opts: { undo?: boolean } = {}): Promise<void> {
    const host = this.host;
    if (!host || this._pending.has(post.id)) return;
    const refusal = getPostScheduleError(
      { publishedAt: new Date(post.publishedAt) },
      when,
      this._now
    );
    if (refusal) {
      this.#toast(refusal, 'error');
      return;
    }
    const expectedScope = scopeOf(post);
    const from = post.publishedAt;
    this.#setPending(post.id, true);
    this.#optimisticTo.set(post.id, when.toISOString());
    this.#override(post.id, when.toISOString());
    try {
      const result = await host.backend.reschedule({
        id: post.id,
        publishedAt: when.toISOString(),
        expectedScope,
      });
      this.#applyMove(post.id, result);
      this.#emit('rescheduled', { id: post.id, ...result });
      const label = result.scope === 'post' ? 'Moved to' : 'Release moved to';
      this.#toast(`${label} ${formatDateTime(new Date(result.publishedAt))}`);
      this._announcement = `${label} ${formatDateTime(new Date(result.publishedAt))}`;
      this._undo =
        opts.undo === false
          ? null
          : { id: post.id, from, expectedScope, until: Date.now() + UNDO_WINDOW_MS };
      this.#armUndoExpiry();
      if (this._selectedId === post.id) this._draftWhen = new Date(result.publishedAt);
    } catch (error) {
      this.#override(post.id, null);
      this.#toast(messageOf(error, 'Could not move that post.'), 'error');
      this.#emit('error', { message: messageOf(error, 'Could not move that post.') });
      void this.#load();
    } finally {
      this.#optimisticTo.delete(post.id);
      this.#setPending(post.id, false);
    }
  }

  async #undoMove(): Promise<void> {
    const undo = this._undo;
    if (!undo) return;
    const post = this.#posts.find((p) => p.id === undo.id);
    this._undo = null;
    if (!post) return;
    await this.#reschedule(post, new Date(undo.from), { undo: false });
  }

  async #publishNow(post: PlannerPost): Promise<void> {
    const host = this.host;
    if (!host || this._pending.has(post.id)) return;
    const scope = scopeOf(post);
    const what = scope === 'post' ? 'this post' : releaseScopeLabel(scope);
    const ok = await this.#confirm({
      heading: 'Publish now?',
      message: `Publish ${what} now? It goes live immediately and can't be scheduled again.`,
      confirmLabel: 'Publish now',
    });
    if (!ok) return;
    this.#setPending(post.id, true);
    try {
      const result = await host.backend.publishNow({ id: post.id, expectedScope: scope });
      this.#applyMove(post.id, result);
      this.#emit('published', { id: post.id, ...result });
      this.#toast(scope === 'post' ? 'Post published.' : 'Release published.');
      this.#close();
      void this.#load();
    } catch (error) {
      this.#toast(messageOf(error, 'Could not publish that post.'), 'error');
      void this.#load();
    } finally {
      this.#setPending(post.id, false);
    }
  }

  async #unschedule(ids: number[]): Promise<void> {
    const host = this.host;
    if (!host || ids.length === 0 || ids.some((id) => this._pending.has(id))) return;
    const ok = await this.#confirm({
      heading: ids.length === 1 ? 'Unschedule this post?' : `Unschedule ${ids.length} posts?`,
      message:
        ids.length === 1
          ? 'It becomes a draft and stays in your account.'
          : 'They become drafts and stay in your account.',
      confirmLabel: 'Unschedule',
      destructive: true,
    });
    if (!ok) return;
    for (const id of ids) this.#setPending(id, true);
    try {
      const result = await host.backend.unschedule(ids);
      this.#emit('unscheduled', { ids: result.unscheduledIds });
      this.#toast(unscheduledMessage(result));
      if (this._selectedId != null && result.unscheduledIds.includes(this._selectedId))
        this.#close();
      this._selectedIds = new Set();
      void this.#load();
    } catch (error) {
      this.#toast(messageOf(error, 'Could not unschedule.'), 'error');
    } finally {
      for (const id of ids) this.#setPending(id, false);
    }
  }

  async #shiftSelected(deltaMinutes: number): Promise<void> {
    const host = this.host;
    const ids = [...this._selectedIds];
    if (!host || ids.length === 0) return;
    try {
      const result = await host.backend.shift({ ids, deltaMinutes });
      const next = new Map(this._overrides);
      for (const moved of result.moved) {
        const from = this.#serverDate(moved.id);
        if (from) next.set(moved.id, { from, to: moved.publishedAt });
      }
      this._overrides = next;
      this.#emit('shifted', { moved: result.moved });
      this.#toast(shiftedMessage(result, deltaMinutes));
      void this.#load();
    } catch (error) {
      this.#toast(messageOf(error, 'Could not shift those posts.'), 'error');
      void this.#load();
    }
  }

  #applyMove(id: number, result: MoveResult): void {
    const next = new Map(this._overrides);
    for (const movedId of [id, ...result.movedPostIds]) {
      const from = this.#serverDate(movedId);
      if (from) next.set(movedId, { from, to: result.publishedAt });
    }
    this._overrides = next;
    if (this._detail?.id === id) this._detail = null;
    void this.#load();
  }

  #serverDate(id: number): string | null {
    return this._range?.posts.find((p) => p.id === id)?.publishedAt ?? null;
  }

  #optimisticTo = new Map<number, string>();

  /** Clearing only removes the override this caller set, never one a later action replaced it with. */
  #override(id: number, to: string | null): void {
    const next = new Map(this._overrides);
    const from = this.#serverDate(id);
    if (to && from) next.set(id, { from, to });
    else if (!to && next.get(id)?.to === this.#optimisticTo.get(id)) next.delete(id);
    this._overrides = next;
  }

  #setPending(id: number, pending: boolean): void {
    const next = new Set(this._pending);
    if (pending) next.add(id);
    else next.delete(id);
    this._pending = next;
  }

  #armUndoExpiry(): void {
    if (this.#undoTimer) clearTimeout(this.#undoTimer);
    this.#undoTimer = setTimeout(() => {
      if (this._undo && this._undo.until <= Date.now()) this._undo = null;
    }, UNDO_WINDOW_MS + 50);
  }

  #toast(message: string, color?: 'error' | 'success'): void {
    const region = this.renderRoot.querySelector<CivitaiToastRegion>('civitai-toast-region');
    region?.show({ message, color });
  }

  async #confirm(opts: {
    heading: string;
    message: string;
    confirmLabel: string;
    destructive?: boolean;
  }): Promise<boolean> {
    const dialog = this.renderRoot.querySelector<CivitaiConfirmDialog>('civitai-confirm-dialog');
    if (!dialog) return window.confirm(opts.message);
    dialog.heading = opts.heading;
    dialog.message = opts.message;
    dialog.confirmLabel = opts.confirmLabel;
    dialog.destructive = opts.destructive ?? false;
    return dialog.ask();
  }

  #emit<K extends keyof PlannerEventMap>(type: K, detail: PlannerEventMap[K]['detail']): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** Shift+arrows move a focused post without a pointer: ←/→ a day, ↑/↓ an hour. */
  #onChipKey(post: PlannerPost, event: KeyboardEvent): void {
    if (!event.shiftKey || !this.#isScheduled(post) || this._selectMode) return;
    const deltaMinutes =
      event.key === 'ArrowRight'
        ? 1440
        : event.key === 'ArrowLeft'
        ? -1440
        : event.key === 'ArrowDown'
        ? 60
        : event.key === 'ArrowUp'
        ? -60
        : 0;
    if (!deltaMinutes) return;
    event.preventDefault();
    const target = new Date(new Date(post.publishedAt).getTime() + deltaMinutes * 60_000);
    if (post.release) {
      this.#open(post, target);
      this._announcement = `Release posts move from the panel. Opened ${formatDateTime(
        target
      )} for confirmation.`;
      return;
    }
    this._announcement = `Moving to ${formatDateTime(target)}`;
    void this.#reschedule(post, target);
  }

  #onDragStart(post: PlannerPost, event: DragEvent): void {
    this._dragId = post.id;
    event.dataTransfer?.setData('text/plain', String(post.id));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  #onDragEnd(): void {
    this._dragId = null;
    this._dragOver = null;
  }

  #onDragOver(dayKey: string, event: DragEvent): void {
    if (this._dragId == null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (this._dragOver !== dayKey) this._dragOver = dayKey;
  }

  #onDrop(dayKey: string, event: DragEvent): void {
    event.preventDefault();
    const post = this.#posts.find((p) => p.id === this._dragId);
    this._dragId = null;
    this._dragOver = null;
    if (!post || !this.#isScheduled(post)) return;
    if (this._pending.has(post.id)) {
      this.#toast('That post is still moving. Try again in a moment.', 'error');
      return;
    }
    if (localDayKey(new Date(post.publishedAt)) === dayKey) return;
    const target = snapToFiveMinutes(moveToDay(new Date(post.publishedAt), dayKey));
    // A release drop moves a model and its other posts, so it is confirmed in the drawer.
    if (post.release) {
      this.#open(post, target);
      return;
    }
    void this.#reschedule(post, target);
  }

  #rowAction(post: PlannerPost, action: string): void {
    if (action !== 'open' && this._pending.has(post.id)) return;
    if (action === 'open') this.#open(post);
    else if (action === 'publish') void this.#publishNow(post);
    else if (action === 'unschedule') void this.#unschedule([post.id]);
  }

  #link(event: Event, loc: PlannerLocation): void {
    // Real hrefs keep middle-click and open-in-new-tab working; a plain click stays in the host.
    const mouse = event as MouseEvent;
    if (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.button === 1) return;
    event.preventDefault();
    this.#navigate(loc);
  }

  #actions: PlannerActions = {
    navigate: (loc) => this.#navigate(loc),
    link: (event, loc) => this.#link(event, loc),
    setFilters: (filters) => (this._filters = { ...this._filters, ...filters }),
    setShowMature: (value) => this.#setShowMature(value),
    toggleSelectMode: () => {
      this._selectMode = !this._selectMode;
      if (!this._selectMode) this._selectedIds = new Set();
    },
    clearSelection: () => (this._selectedIds = new Set()),
    toggleSelected: (id) => this.#toggleSelected(id),
    toggleUnblur: (id) => this.#toggleUnblur(id),
    open: (post, at) => this.#open(post, at),
    close: () => this.#close(),
    setDraft: (date, time) =>
      (this._draftWhen = mergeDraftInput(this._draftWhen ?? this._now, date, time)),
    toggleDescription: () => (this._descriptionExpanded = !this._descriptionExpanded),
    setLightbox: (index) => (this._lightbox = index),
    reschedule: (post, when) => void this.#reschedule(post, when),
    publishNow: (post) => void this.#publishNow(post),
    unschedule: (ids) => void this.#unschedule(ids),
    shiftSelected: (deltaMinutes) => void this.#shiftSelected(deltaMinutes),
    undoMove: () => void this.#undoMove(),
    rowAction: (post, action) => this.#rowAction(post, action),
    onChipKey: (post, event) => this.#onChipKey(post, event),
    onDrawerKey: this.#onDrawerKey,
    onDragStart: (post, event) => this.#onDragStart(post, event),
    onDragEnd: () => this.#onDragEnd(),
    onDragOver: (dayKey, event) => this.#onDragOver(dayKey, event),
    onDragLeave: (dayKey) => {
      if (this._dragOver === dayKey) this._dragOver = null;
    },
    onDrop: (dayKey, event) => this.#onDrop(dayKey, event),
  };

  override render(): TemplateResult {
    const host = this.host;
    if (!host) return html`<p class="muted">Waiting for a host context…</p>`;
    const loc = this.#loc;
    const posts = this.#posts;
    const modelOptions = modelFilterOptions(posts);
    const context: PostContext = {
      host,
      selectMode: this._selectMode,
      selectedIds: this._selectedIds,
      pending: this._pending,
      dragId: this._dragId,
      isScheduled: this.#isScheduled,
      isBlurred: this.#isBlurred,
      actions: this.#actions,
    };
    return html`
      <div class="shell ${this._selectedId != null ? 'with-drawer' : ''}">
        <div class="main">
          ${renderHeader({
            host,
            scheduledCount: countScheduled(posts, this._now),
            dailyLimit: this._range?.dailyLimit ?? null,
          })}
          ${renderToolbar({
            host,
            loc,
            today: this.#today,
            loading: this._loading,
            filters: this._filters,
            showMature: this._showMature,
            hasMature: hasMature(posts),
            selectMode: this._selectMode,
            modelOptions,
            actions: this.#actions,
          })}
          ${renderLegend()} ${this._error ? renderNotice(this._error) : nothing}
          ${this._range?.truncated
            ? renderTruncatedNotice({
                view: loc.view,
                posts,
                hasModelFilter: modelOptions.length > 0,
              })
            : nothing}
          ${this._undo
            ? renderUndo({ until: this._undo.until, onUndo: this.#actions.undoMove })
            : nothing}
          ${renderView({
            loc,
            today: this.#today,
            now: this._now,
            narrow: this._narrow,
            loading: this._loading,
            loaded: this._range != null,
            posts: this.#visiblePosts,
            cap: this._range?.dailyLimit ?? 0,
            dragOver: this._dragOver,
            context,
          })}
          ${this._selectMode
            ? renderBulkBar({ selectedIds: this._selectedIds, actions: this.#actions })
            : nothing}
        </div>
        ${this._selectedId != null ? this.#drawer(host, posts) : nothing}
      </div>
      <div class="sr-only" role="status" aria-live="polite">${this._announcement}</div>
      <civitai-toast-region></civitai-toast-region>
      <civitai-confirm-dialog></civitai-confirm-dialog>
    `;
  }

  #drawer(host: PlannerHost, posts: PlannerPost[]): TemplateResult {
    const list = posts.find((p) => p.id === this._selectedId) ?? null;
    const detail = this._detail?.id === this._selectedId ? this._detail : null;
    const post = drawerPost(list, detail);
    if (!post) return html``;
    const { prev, next } = neighbours(this.#visiblePosts, post.id);
    return renderDrawer({
      host,
      post,
      detail,
      detailLoading: this._detailLoading,
      scheduled: this.#isScheduled(post),
      pending: this._pending.has(post.id),
      draft: this._draftWhen ?? new Date(post.publishedAt),
      now: this._now,
      cap: this._range?.dailyLimit,
      sameDay: countScheduledOn(posts, localDayKey(new Date(post.publishedAt)), this._now),
      descriptionExpanded: this._descriptionExpanded,
      lightbox: this._lightbox,
      prev,
      next,
      isBlurred: this.#isBlurred,
      actions: this.#actions,
    });
  }
}

function showMatureKey(userId: number | undefined): string {
  return userId == null ? SHOW_MATURE_KEY : `${SHOW_MATURE_KEY}:${userId}`;
}

function readStoredShowMature(userId: number | undefined): boolean | null {
  try {
    const stored = localStorage.getItem(showMatureKey(userId));
    return stored == null ? null : stored === '1';
  } catch {
    return null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'civitai-post-planner': CivitaiPostPlanner;
  }
}
