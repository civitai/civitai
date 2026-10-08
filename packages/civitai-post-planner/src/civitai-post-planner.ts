import '@civitai/components/register';
import { CivitaiElement } from '@civitai/components/internals';
import type { CivitaiConfirmDialog } from '@civitai/components/civitai-confirm-dialog';
import type { CivitaiToastRegion } from '@civitai/components/civitai-toast-region';
import type { CivitaiSegmentedControl } from '@civitai/components/civitai-segmented-control';
import type { CivitaiSelect } from '@civitai/components/civitai-select';
import {
  getPostScheduleError,
  POST_MAXIMUM_SCHEDULE_MONTHS,
  POST_MINIMUM_SCHEDULE_MINUTES,
} from '@civitai/shared/post-scheduling';
import {
  html,
  nothing,
  type PropertyDeclarations,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import type {
  MoveResult,
  PlannerEventMap,
  PlannerHost,
  PlannerLocation,
  PlannerPost,
  PlannerPostDetail,
  PlannerScope,
  PlannerView,
  ScheduledRange,
} from './host.js';
import { hostLink } from './host.js';
import {
  addDays,
  bucketByLocalDay,
  type CalendarDay,
  dayStart,
  defaultView,
  formatDateTime,
  formatRangeLabel,
  formatTime,
  localDayKey,
  monthGrid,
  moveToDay,
  snapToFiveMinutes,
  stepAnchor,
  visibleRange,
  weekDays,
} from './model/calendar.js';
import { eyeIcon, handleIcon, PG_LEVEL, rocketIcon, shouldBlur, thumb } from './parts/media.js';
import { plannerStyles } from './styles.js';

const MONTH_CHIPS_PER_CELL = 3;
const UNDO_WINDOW_MS = 8_000;
const SHOW_MATURE_KEY = 'civitai-post-planner:show-mature';
const VIEWS: { value: PlannerView; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'agenda', label: 'Agenda' },
];

type Filters = { scheduled: boolean; published: boolean; releases: boolean };
type Undo = { id: number; from: string; expectedScope: PlannerScope; until: number };

export class CivitaiPostPlanner extends CivitaiElement {
  static override styles = [plannerStyles];

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
  declare _overrides: Map<number, { from: string; to: string }>;
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
    const posts = this._range?.posts ?? [];
    return posts.map((p) => {
      const moved = this._overrides.get(p.id);
      return moved ? { ...p, publishedAt: moved.to } : p;
    });
  }

  get #visiblePosts(): PlannerPost[] {
    const { scheduled, published, releases } = this._filters;
    const mv = this.#loc.modelVersionId;
    return this.#posts.filter((p) => {
      if (mv && p.modelVersionId !== mv) return false;
      if (p.release && !releases) return false;
      return this.#isScheduled(p) ? scheduled : published;
    });
  }

  #isScheduled(post: PlannerPost): boolean {
    return new Date(post.publishedAt) > this._now;
  }

  #scopeOf(post: PlannerPost): PlannerScope {
    return post.release?.scope ?? 'post';
  }

  #isBlurred(post: Pick<PlannerPost, 'id' | 'nsfwLevel'>): boolean {
    const level = this.host?.config.browsingLevel ?? 0;
    return shouldBlur(post.nsfwLevel, level, this._showMature, this._unblurred.has(post.id));
  }

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
      const kept = new Map<number, { from: string; to: string }>();
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
    const expectedScope = this.#scopeOf(post);
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
    const scope = this.#scopeOf(post);
    const what =
      scope === 'post'
        ? 'this post'
        : scope === 'model'
        ? 'the whole model release'
        : "this version's release";
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
      const skipped = result.skippedReleaseIds.length;
      this.#toast(
        `${result.unscheduledIds.length} post${
          result.unscheduledIds.length === 1 ? '' : 's'
        } moved to drafts.` +
          (skipped
            ? ` ${skipped} release post${
                skipped === 1 ? '' : 's'
              } not moved — they move with their model.`
            : '')
      );
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
      const skipped = result.skippedReleaseIds.length;
      const days = deltaMinutes / 1440;
      const label = Number.isInteger(days)
        ? `${days > 0 ? '+' : ''}${days} day${Math.abs(days) === 1 ? '' : 's'}`
        : `${deltaMinutes > 0 ? '+' : ''}${deltaMinutes} min`;
      this.#toast(
        `${result.moved.length} post${result.moved.length === 1 ? '' : 's'} shifted by ${label}.` +
          (skipped ? ` ${skipped} release post${skipped === 1 ? '' : 's'} not moved.` : '')
      );
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

  override render(): TemplateResult {
    if (!this.host) return html`<p class="muted">Waiting for a host context…</p>`;
    const loc = this.#loc;
    return html`
      <div class="shell ${this._selectedId != null ? 'with-drawer' : ''}">
        <div class="main">
          ${this.#renderHeader()} ${this.#renderToolbar(loc)} ${this.#renderLegend()}
          ${this._error ? html`<div class="notice">${this._error}</div>` : nothing}
          ${this._range?.truncated ? this.#renderTruncatedNotice(loc) : nothing}
          ${this._undo ? this.#renderUndo() : nothing} ${this.#renderView(loc)}
          ${this._selectMode ? this.#renderBulkBar() : nothing}
        </div>
        ${this._selectedId != null ? this.#renderDrawer() : nothing}
      </div>
      <div class="sr-only" role="status" aria-live="polite">${this._announcement}</div>
      <civitai-toast-region></civitai-toast-region>
      <civitai-confirm-dialog></civitai-confirm-dialog>
    `;
  }

  #renderHeader(): TemplateResult {
    const scheduled = this.#posts.filter((p) => this.#isScheduled(p)).length;
    const range = this._range;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parts = [
      `${scheduled} queued in view`,
      range ? `${range.dailyLimit}/day limit` : null,
      zone,
    ].filter(Boolean);
    const composer = this.host?.config.composerAvailable && this.host.composerUrl;
    return html`
      <header class="top">
        <div>
          <h1>Scheduled posts</h1>
          <div class="stat">${parts.join(' · ')}</div>
        </div>
        ${composer
          ? html`<civitai-button variant="filled" href=${this.host!.composerUrl!({})}
              >+ Schedule a batch</civitai-button
            >`
          : nothing}
      </header>
    `;
  }

  #renderToolbar(loc: PlannerLocation): TemplateResult {
    const todayLoc = { ...loc, anchor: this.#today };
    return html`
      <div class="toolbar">
        <civitai-segmented-control
          aria-label="View"
          size="sm"
          .data=${VIEWS}
          .value=${loc.view}
          @change=${(e: Event) => {
            const view = (e.target as CivitaiSegmentedControl).value as PlannerView;
            if (view && view !== loc.view) this.#navigate({ ...loc, view });
          }}
        ></civitai-segmented-control>
        <civitai-button-group>
          <civitai-button
            variant="outline"
            size="sm"
            href=${this.host!.hrefFor({ ...loc, anchor: stepAnchor(loc.view, loc.anchor, -1) })}
            @click=${(e: Event) =>
              this.#link(e, { ...loc, anchor: stepAnchor(loc.view, loc.anchor, -1) })}
            aria-label="Previous"
            >‹</civitai-button
          >
          <civitai-button
            variant="outline"
            size="sm"
            href=${this.host!.hrefFor(todayLoc)}
            @click=${(e: Event) => this.#link(e, todayLoc)}
            >Today</civitai-button
          >
          <civitai-button
            variant="outline"
            size="sm"
            href=${this.host!.hrefFor({ ...loc, anchor: stepAnchor(loc.view, loc.anchor, 1) })}
            @click=${(e: Event) =>
              this.#link(e, { ...loc, anchor: stepAnchor(loc.view, loc.anchor, 1) })}
            aria-label="Next"
            >›</civitai-button
          >
        </civitai-button-group>
        <span class="range"
          >${formatRangeLabel(loc.view, loc.anchor)}${this._loading
            ? html` <civitai-loader size="sm" label="Loading"></civitai-loader>`
            : nothing}</span
        >
        <span class="spacer"></span>
        ${this.#renderModelFilter(loc)}
        <div class="filters">
          <civitai-checkbox
            label="Scheduled"
            size="sm"
            .checked=${this._filters.scheduled}
            @change=${(e: Event) =>
              (this._filters = {
                ...this._filters,
                scheduled: (e.target as HTMLInputElement).checked,
              })}
          ></civitai-checkbox>
          <civitai-checkbox
            label="Published"
            size="sm"
            .checked=${this._filters.published}
            @change=${(e: Event) =>
              (this._filters = {
                ...this._filters,
                published: (e.target as HTMLInputElement).checked,
              })}
          ></civitai-checkbox>
          <civitai-checkbox
            label="Releases"
            size="sm"
            .checked=${this._filters.releases}
            @change=${(e: Event) =>
              (this._filters = {
                ...this._filters,
                releases: (e.target as HTMLInputElement).checked,
              })}
          ></civitai-checkbox>
        </div>
        ${this.#hasMature()
          ? html`<civitai-switch
              label="Show mature"
              size="sm"
              .checked=${this._showMature}
              @change=${(e: Event) => this.#setShowMature((e.target as HTMLInputElement).checked)}
            ></civitai-switch>`
          : nothing}
        <civitai-button
          variant=${this._selectMode ? 'light' : 'outline'}
          size="sm"
          @click=${() => {
            this._selectMode = !this._selectMode;
            if (!this._selectMode) this._selectedIds = new Set();
          }}
          >${this._selectMode ? 'Done' : 'Select'}</civitai-button
        >
      </div>
    `;
  }

  #modelFilterOptions(): { value: string; label: string }[] {
    const versions = new Map<number, string>();
    for (const post of this.#posts) {
      if (!post.modelVersionId) continue;
      if (post.release)
        versions.set(
          post.modelVersionId,
          `${post.release.modelName} · ${post.release.versionName}`
        );
      else if (!versions.has(post.modelVersionId))
        versions.set(post.modelVersionId, `Version #${post.modelVersionId}`);
    }
    return [...versions].map(([id, label]) => ({ value: String(id), label }));
  }

  #renderModelFilter(loc: PlannerLocation): TemplateResult | typeof nothing {
    const options = this.#modelFilterOptions();
    if (options.length === 0 && !loc.modelVersionId) return nothing;
    const data = [{ value: '', label: 'All models' }, ...options];
    return html`<civitai-select
      aria-label="Model"
      size="sm"
      .data=${data}
      .value=${loc.modelVersionId ? String(loc.modelVersionId) : ''}
      @change=${(e: Event) => {
        const value = (e.target as CivitaiSelect).value;
        this.#navigate({ ...loc, modelVersionId: value ? Number(value) : undefined });
      }}
    ></civitai-select>`;
  }

  #hasMature(): boolean {
    return this.#posts.some((p) => p.nsfwLevel > PG_LEVEL);
  }

  #renderLegend(): TemplateResult {
    return html`<div class="legend">
      <span class="scheduled"><i></i>scheduled</span>
      <span class="release"><i></i>release — moves with its model</span>
      <span class="published"><i></i>published</span>
    </div>`;
  }

  #renderUndo(): TemplateResult {
    if (!this._undo || this._undo.until <= Date.now()) return html``;
    return html`<div class="notice">
      <span>Moved. </span>
      <civitai-button variant="subtle" size="sm" @click=${() => void this.#undoMove()}
        >Undo</civitai-button
      >
    </div>`;
  }

  #renderTruncatedNotice(loc: PlannerLocation): TemplateResult {
    const posts = this.#posts;
    const last = posts.length ? new Date(posts[posts.length - 1].publishedAt) : null;
    const lastLabel = last
      ? last.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      : null;
    const hasModelFilter = this.#modelFilterOptions().length > 0;
    const narrower =
      loc.view === 'month' ? 'Week or Day' : loc.view === 'week' ? 'Day' : 'a shorter range';
    return html`<div class="notice">
      <span>
        This range holds more than ${posts.length} posts;
        ${lastLabel ? `days after ${lastLabel} are incomplete` : 'the end of it is cut off'}. Switch
        to ${narrower}${hasModelFilter ? ' or filter by model' : ''} to see everything.
      </span>
    </div>`;
  }

  #renderView(loc: PlannerLocation): TemplateResult {
    if (!this._range && this._loading) {
      return html`<div class="loading" role="status">
        <civitai-loader size="lg" label="Loading your schedule"></civitai-loader>
        <span class="muted">Loading your schedule…</span>
      </div>`;
    }
    // A seven-column grid has no room on a phone; the same range reads fine as a day list.
    if (this._narrow && loc.view === 'month') {
      const days = monthGrid(loc.anchor, this.#today)
        .filter((d) => d.inMonth)
        .map((d) => d.key);
      return this.#renderList(days, { skipEmpty: true });
    }
    switch (loc.view) {
      case 'month':
        return this.#renderMonth(loc);
      case 'week':
        return this.#renderList(weekDays(loc.anchor, this.#today).map((d) => d.key));
      case 'day':
        return this.#renderList([loc.anchor]);
      case 'agenda':
        return this.#renderList(
          Array.from({ length: 42 }, (_, i) => addDays(loc.anchor, i)),
          { skipEmpty: true }
        );
    }
  }

  #renderMonth(loc: PlannerLocation): TemplateResult {
    const days = monthGrid(loc.anchor, this.#today);
    const byDay = bucketByLocalDay(this.#visiblePosts);
    const cap = this._range?.dailyLimit ?? 0;
    return html`
      <div class="weekdays" role="row">
        ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(
          (d) => html`<div role="columnheader">${d}</div>`
        )}
      </div>
      <div class="grid month" role="grid" aria-label=${formatRangeLabel('month', loc.anchor)}>
        ${repeat(
          weeksOf(days),
          (week) => week[0].key,
          (week) => html`<div class="week" role="row">
            ${repeat(
              week,
              (d) => d.key,
              (day) => this.#renderCell(day, byDay.get(day.key) ?? [], cap, loc)
            )}
          </div>`
        )}
      </div>
      <div class="muted">
        Day counts are the posts scheduled that day; the daily limit is counted on UTC days by the
        server.
      </div>
    `;
  }

  #renderCell(
    day: CalendarDay,
    posts: PlannerPost[],
    cap: number,
    loc: PlannerLocation
  ): TemplateResult {
    const scheduled = posts.filter((p) => this.#isScheduled(p)).length;
    const badgeColor = cap && scheduled > cap ? 'error' : cap && scheduled === cap ? 'warning' : '';
    const shown = posts.slice(0, MONTH_CHIPS_PER_CELL);
    const hidden = posts.length - shown.length;
    const canQuickAdd =
      posts.length === 0 &&
      this.host?.config.composerAvailable &&
      this.host.composerUrl &&
      day.key >= this.#today;
    const classes = [
      'cell',
      day.inMonth ? '' : 'out',
      day.isToday ? 'today' : '',
      this._dragOver === day.key ? 'over' : '',
    ].join(' ');
    return html`
      <div
        class=${classes}
        role="gridcell"
        @dragover=${(e: DragEvent) => this.#onDragOver(day.key, e)}
        @dragleave=${() => {
          if (this._dragOver === day.key) this._dragOver = null;
        }}
        @drop=${(e: DragEvent) => this.#onDrop(day.key, e)}
      >
        <div class="cell-head">
          <span class="num">${day.day}</span>
          ${scheduled
            ? html`<civitai-badge
                size="sm"
                variant=${badgeColor ? 'filled' : 'light'}
                color=${badgeColor}
                >${scheduled}${cap ? `/${cap}` : ''}</civitai-badge
              >`
            : nothing}
        </div>
        ${shown.map((post) => this.#renderChip(post))}
        ${hidden > 0
          ? html`<button
              class="plain more"
              @click=${() => this.#navigate({ ...loc, view: 'day', anchor: day.key })}
            >
              +${hidden} more
            </button>`
          : nothing}
        ${canQuickAdd
          ? html`<a
              class="quick-add"
              href=${hostLink(this.host!.composerUrl!({ startAt: dayStart(day.key).toISOString() }))
                .href}
              target=${ifDefined(
                hostLink(this.host!.composerUrl!({ startAt: dayStart(day.key).toISOString() }))
                  .target
              )}
              rel=${ifDefined(
                hostLink(this.host!.composerUrl!({ startAt: dayStart(day.key).toISOString() })).rel
              )}
              aria-label="Schedule a batch starting ${day.key}"
              >+</a
            >`
          : nothing}
      </div>
    `;
  }

  #renderChip(post: PlannerPost): TemplateResult {
    const scheduled = this.#isScheduled(post);
    const classes = [
      'chip',
      post.release ? 'release' : '',
      scheduled ? '' : 'published',
      this._pending.has(post.id) ? 'pending' : '',
      this._dragId === post.id ? 'dragging' : '',
      this._selectedIds.has(post.id) ? 'selected' : '',
    ].join(' ');
    const when = new Date(post.publishedAt);
    return html`
      <button
        type="button"
        class=${classes}
        draggable=${scheduled && !this._selectMode && !this._pending.has(post.id)
          ? 'true'
          : 'false'}
        aria-label="${formatTime(when)}, ${post.title ??
        'untitled'}, ${post.imageCount} items${post.release ? ', release' : ''}${scheduled
          ? ''
          : ', published'}"
        @click=${() =>
          this._selectMode && scheduled ? this.#toggleSelected(post.id) : this.#open(post)}
        @keydown=${(e: KeyboardEvent) => this.#onChipKey(post, e)}
        @dragstart=${(e: DragEvent) => this.#onDragStart(post, e)}
        @dragend=${() => this.#onDragEnd()}
      >
        ${this._selectMode && scheduled
          ? html`<civitai-checkbox
              size="sm"
              tabindex="-1"
              aria-hidden="true"
              .checked=${this._selectedIds.has(post.id)}
              @click=${(e: Event) => e.stopPropagation()}
              @change=${() => this.#toggleSelected(post.id)}
            ></civitai-checkbox>`
          : thumb({
              imageLocation: this.host!.config.imageLocation,
              media: post.cover,
              blurred: this.#isBlurred(post),
            })}
        <span class="time">${formatTime(when)}</span>
        ${post.release ? rocketIcon : nothing}
        ${post.title
          ? html`<span class="title">${post.title}</span>`
          : html`<span class="count"
              >· ${post.imageCount} item${post.imageCount === 1 ? '' : 's'}</span
            >`}
        ${scheduled && !this._selectMode ? handleIcon : nothing}
      </button>
    `;
  }

  #renderList(dayKeys: string[], opts: { skipEmpty?: boolean } = {}): TemplateResult {
    const byDay = bucketByLocalDay(this.#visiblePosts);
    const cap = this._range?.dailyLimit ?? 0;
    const groups = dayKeys.filter((key) => !opts.skipEmpty || byDay.has(key));
    if (groups.length === 0) return html`<div class="empty">Nothing scheduled in this range.</div>`;
    return html`${groups.map((key) => {
      const posts = byDay.get(key) ?? [];
      const scheduled = posts.filter((p) => this.#isScheduled(p)).length;
      const color = cap && scheduled > cap ? 'error' : cap && scheduled === cap ? 'warning' : '';
      return html`<section
        class="day-group"
        @dragover=${(e: DragEvent) => this.#onDragOver(key, e)}
        @drop=${(e: DragEvent) => this.#onDrop(key, e)}
      >
        <h3>
          ${dayStart(key).toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          })}
          ${scheduled
            ? html`<civitai-badge size="sm" variant=${color ? 'filled' : 'light'} color=${color}
                >${scheduled}${cap ? `/${cap}` : ''}</civitai-badge
              >`
            : nothing}
        </h3>
        ${posts.length === 0
          ? html`<div class="empty">No posts scheduled.</div>`
          : posts.map((post) => this.#renderRow(post))}
      </section>`;
    })}`;
  }

  #renderRow(post: PlannerPost): TemplateResult {
    const scheduled = this.#isScheduled(post);
    const classes = [
      'row',
      post.release ? 'release' : '',
      scheduled ? '' : 'published',
      this._selectedIds.has(post.id) ? 'selected' : '',
    ].join(' ');
    const when = new Date(post.publishedAt);
    return html`<div
      class=${classes}
      role="button"
      tabindex="0"
      draggable=${scheduled && !this._selectMode && !this._pending.has(post.id) ? 'true' : 'false'}
      @dragstart=${(e: DragEvent) => this.#onDragStart(post, e)}
      @dragend=${() => this.#onDragEnd()}
      @click=${() =>
        this._selectMode && scheduled ? this.#toggleSelected(post.id) : this.#open(post)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (this._selectMode && scheduled) this.#toggleSelected(post.id);
          else this.#open(post);
          return;
        }
        this.#onChipKey(post, e);
      }}
    >
      ${this._selectMode
        ? html`<civitai-checkbox
            size="sm"
            .checked=${this._selectedIds.has(post.id)}
            ?disabled=${!scheduled || !!post.release}
            @click=${(e: Event) => e.stopPropagation()}
            @change=${() => this.#toggleSelected(post.id)}
          ></civitai-checkbox>`
        : html`<span></span>`}
      ${thumb({
        imageLocation: this.host!.config.imageLocation,
        media: post.cover,
        blurred: this.#isBlurred(post),
        large: true,
      })}
      <div class="meta">
        <div class="line">
          <span class="time">${formatTime(when)}</span
          ><span
            >${post.title ?? 'Untitled'} · ${post.imageCount}
            item${post.imageCount === 1 ? '' : 's'}</span
          >
        </div>
        <div class="line">
          ${post.release
            ? html`<civitai-badge size="sm" color="warning">Release</civitai-badge
                ><span class="muted">${post.release.modelName} · ${post.release.versionName}</span>`
            : nothing}
          <span class="muted">${scheduled ? 'Scheduled' : 'Published'}</span>
        </div>
      </div>
      ${scheduled
        ? html`<civitai-menu
            label="Actions"
            placement="bottom-end"
            @click=${(e: Event) => e.stopPropagation()}
            @select=${(e: CustomEvent<{ value: string }>) => this.#rowAction(post, e.detail.value)}
          >
            <civitai-button slot="trigger" variant="subtle" size="sm" aria-label="Actions"
              >⋯</civitai-button
            >
            <civitai-menu-item value="open">Details</civitai-menu-item>
            <civitai-menu-item value="publish">Publish now</civitai-menu-item>
            ${post.release
              ? nothing
              : html`<civitai-menu-item value="unschedule" destructive
                  >Unschedule</civitai-menu-item
                >`}
          </civitai-menu>`
        : html`<span></span>`}
    </div>`;
  }

  #rowAction(post: PlannerPost, action: string): void {
    if (action !== 'open' && this._pending.has(post.id)) return;
    if (action === 'open') this.#open(post);
    else if (action === 'publish') void this.#publishNow(post);
    else if (action === 'unschedule') void this.#unschedule([post.id]);
  }

  #renderBulkBar(): TemplateResult {
    const count = this._selectedIds.size;
    return html`<div class="bulk-bar">
      <strong>${count} selected</strong>
      <civitai-button
        size="sm"
        variant="outline"
        ?disabled=${count === 0}
        @click=${() => void this.#shiftSelected(-1440)}
        >−1 day</civitai-button
      >
      <civitai-button
        size="sm"
        variant="outline"
        ?disabled=${count === 0}
        @click=${() => void this.#shiftSelected(1440)}
        >+1 day</civitai-button
      >
      <civitai-button
        size="sm"
        variant="outline"
        ?disabled=${count === 0}
        @click=${() => void this.#shiftSelected(7 * 1440)}
        >+1 week</civitai-button
      >
      <civitai-button
        size="sm"
        variant="outline"
        color="error"
        ?disabled=${count === 0}
        @click=${() => void this.#unschedule([...this._selectedIds])}
        >Unschedule</civitai-button
      >
      <civitai-button size="sm" variant="subtle" @click=${() => (this._selectedIds = new Set())}
        >Clear</civitai-button
      >
      <span class="muted">Release posts move with their model and are skipped.</span>
    </div>`;
  }

  #renderDrawer(): TemplateResult {
    const list = this.#posts.find((p) => p.id === this._selectedId) ?? null;
    const detail = this._detail?.id === this._selectedId ? this._detail : null;
    const post: PlannerPost | null =
      detail && list
        ? { ...detail, publishedAt: list.publishedAt, release: list.release }
        : detail ?? list;
    if (!post) return html``;
    const scheduled = this.#isScheduled(post);
    const visible = this.#visiblePosts.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    const index = visible.findIndex((p) => p.id === post.id);
    const prev = index > 0 ? visible[index - 1] : null;
    const next = index >= 0 && index < visible.length - 1 ? visible[index + 1] : null;
    const draft = this._draftWhen ?? new Date(post.publishedAt);
    const host = this.host!;
    const cap = this._range?.dailyLimit;
    const sameDay = this.#posts.filter(
      (p) =>
        this.#isScheduled(p) &&
        localDayKey(new Date(p.publishedAt)) === localDayKey(new Date(post.publishedAt))
    ).length;
    return html`
      <aside class="drawer" aria-label="Post details" @keydown=${this.#onDrawerKey}>
        <div class="drawer-head">
          <div>
            <h2>
              ${post.title ?? 'Untitled post'} · ${post.imageCount}
              item${post.imageCount === 1 ? '' : 's'}
            </h2>
            <div class="muted">
              ${scheduled ? 'Scheduled for' : 'Published'}
              ${formatDateTime(new Date(post.publishedAt))}
            </div>
          </div>
          <civitai-button
            variant="subtle"
            size="sm"
            aria-label="Close"
            @click=${() => this.#close()}
            >✕</civitai-button
          >
        </div>

        ${this.#renderMediaStrip(post, detail)}
        ${post.release
          ? html`<civitai-alert color="warning">
              This post goes live with ${post.release.modelName} · ${post.release.versionName}.
              Rescheduling or publishing it moves
              ${post.release.scope === 'model'
                ? 'the whole model release'
                : "this version's release"}
              and every post scheduled with it.
            </civitai-alert>`
          : nothing}
        ${detail?.description
          ? html`<div class="section">
              <h4>Description</h4>
              <div class="description ${this._descriptionExpanded ? 'expanded' : ''}">
                ${detail.description}
              </div>
              ${detail.description.length > 240
                ? html`<button
                    class="plain more"
                    @click=${() => (this._descriptionExpanded = !this._descriptionExpanded)}
                  >
                    ${this._descriptionExpanded ? 'Show less' : 'Show more'}
                  </button>`
                : nothing}
            </div>`
          : nothing}
        ${scheduled
          ? html`<div class="section">
              <h4>Goes live</h4>
              <div class="fields">
                <label
                  >Date<input
                    type="date"
                    .value=${toDateInput(draft)}
                    min=${toDateInput(this._now)}
                    @change=${(e: Event) =>
                      this.#setDraft((e.target as HTMLInputElement).value, null)}
                /></label>
                <label
                  >Time<input
                    type="time"
                    step="300"
                    .value=${toTimeInput(draft)}
                    @change=${(e: Event) =>
                      this.#setDraft(null, (e.target as HTMLInputElement).value)}
                /></label>
              </div>
              <civitai-button
                variant="filled"
                full-width
                ?disabled=${this._pending.has(post.id) ||
                draft.getTime() === new Date(post.publishedAt).getTime()}
                ?loading=${this._pending.has(post.id)}
                @click=${() => void this.#reschedule(post, draft)}
              >
                ${post.release ? 'Move release' : 'Reschedule'}
              </civitai-button>
              <div class="muted">
                In your local time. ${POST_MINIMUM_SCHEDULE_MINUTES} minutes to
                ${POST_MAXIMUM_SCHEDULE_MONTHS} months
                ahead.${cap ? ` ${sameDay} of ${cap} on this day.` : ''}
              </div>
            </div>`
          : nothing}
        ${detail?.model
          ? html`<div class="section">
              <h4>Model</h4>
              <div class="pills">
                <a
                  class="pill"
                  href=${hostLink(
                    host.modelPageUrl({
                      modelId: detail.model.id,
                      modelVersionId: post.modelVersionId ?? 0,
                      nsfwLevel: post.nsfwLevel,
                    })
                  ).href}
                  target=${ifDefined(
                    hostLink(
                      host.modelPageUrl({
                        modelId: detail.model.id,
                        modelVersionId: post.modelVersionId ?? 0,
                        nsfwLevel: post.nsfwLevel,
                      })
                    ).target
                  )}
                  rel=${ifDefined(
                    hostLink(
                      host.modelPageUrl({
                        modelId: detail.model.id,
                        modelVersionId: post.modelVersionId ?? 0,
                        nsfwLevel: post.nsfwLevel,
                      })
                    ).rel
                  )}
                  >${detail.model.name} · ${detail.model.versionName}</a
                >
              </div>
            </div>`
          : nothing}
        ${detail && detail.resources.length
          ? html`<div class="section">
              <h4>Resources</h4>
              <div class="pills">
                ${detail.resources.map(
                  (r) =>
                    html`<a
                      class="pill"
                      href=${hostLink(
                        host.modelPageUrl({
                          modelId: r.modelId,
                          modelVersionId: r.versionId,
                          nsfwLevel: post.nsfwLevel,
                        })
                      ).href}
                      target=${ifDefined(
                        hostLink(
                          host.modelPageUrl({
                            modelId: r.modelId,
                            modelVersionId: r.versionId,
                            nsfwLevel: post.nsfwLevel,
                          })
                        ).target
                      )}
                      rel=${ifDefined(
                        hostLink(
                          host.modelPageUrl({
                            modelId: r.modelId,
                            modelVersionId: r.versionId,
                            nsfwLevel: post.nsfwLevel,
                          })
                        ).rel
                      )}
                      >${r.name} <span class="muted">${r.type}</span></a
                    >`
                )}
              </div>
            </div>`
          : nothing}
        ${detail && (detail.tools.length || detail.techniques.length)
          ? html`<div class="section">
              <h4>Tools & techniques</h4>
              <div class="pills">
                ${[...detail.tools, ...detail.techniques].map(
                  (t) => html`<span class="pill">${t}</span>`
                )}
              </div>
            </div>`
          : nothing}
        ${detail && detail.tags.length
          ? html`<div class="section">
              <h4>Tags</h4>
              <div class="pills">
                ${detail.tags.map((t) => html`<span class="pill">#${t}</span>`)}
              </div>
            </div>`
          : nothing}
        ${detail?.stats
          ? html`<div class="section">
              <h4>Engagement</h4>
              <div>${detail.stats.reactions} reactions · ${detail.stats.comments} comments</div>
            </div>`
          : nothing}
        ${this._detailLoading && !detail
          ? html`<div class="muted">
              <civitai-loader size="sm" label="Loading"></civitai-loader> Loading details…
            </div>`
          : nothing}

        <div class="actions">
          ${scheduled
            ? html`
                ${post.release
                  ? nothing
                  : html`<civitai-button
                      variant="outline"
                      full-width
                      @click=${() => void this.#unschedule([post.id])}
                      >Unschedule to draft</civitai-button
                    >`}
                <civitai-button
                  variant="outline"
                  full-width
                  @click=${() => void this.#publishNow(post)}
                >
                  ${post.release
                    ? post.release.scope === 'model'
                      ? 'Publish model now'
                      : 'Publish version now'
                    : 'Publish now'}
                </civitai-button>
              `
            : nothing}
          <div class="links">
            <a
              href=${hostLink(host.editPostUrl(post)).href}
              target=${ifDefined(hostLink(host.editPostUrl(post)).target)}
              rel=${ifDefined(hostLink(host.editPostUrl(post)).rel)}
              >Edit post →</a
            >
            ${scheduled
              ? nothing
              : html`<a
                  href=${hostLink(host.viewPostUrl(post)).href}
                  target=${ifDefined(hostLink(host.viewPostUrl(post)).target)}
                  rel=${ifDefined(hostLink(host.viewPostUrl(post)).rel)}
                  >View post →</a
                >`}
          </div>
        </div>

        <div class="nav-posts">
          ${prev
            ? html`<button class="plain more" @click=${() => this.#open(prev)}>
                ‹ Previous post
              </button>`
            : html`<span></span>`}
          ${next
            ? html`<button class="plain more" @click=${() => this.#open(next)}>Next post ›</button>`
            : html`<span></span>`}
        </div>
      </aside>
    `;
  }

  #renderMediaStrip(post: PlannerPost, detail: PlannerPostDetail | null): TemplateResult {
    const location = this.host!.config.imageLocation;
    const level = this.host!.config.browsingLevel;
    if (!detail) {
      return html`<div class="strip">
        <figure>
          ${thumb({
            imageLocation: location,
            media: post.cover,
            blurred: this.#isBlurred(post),
            large: true,
          })}
        </figure>
      </div>`;
    }
    return html`<div class="strip" aria-label="Media">
        ${detail.media.map((m, i) => {
          const blurred = shouldBlur(
            m.nsfwLevel,
            level,
            this._showMature,
            this._unblurred.has(m.id)
          );
          return html`<figure>
            <button
              class="plain zoom"
              aria-label="Open item ${i + 1} of ${detail.media.length}"
              @click=${() => (this._lightbox = i)}
            >
              ${m.type === 'audio'
                ? html`<span class="thumb lg"></span>`
                : html`<img
                    class=${blurred ? 'blurred' : ''}
                    src=${mediaSrc(location, m.url, 192)}
                    alt=""
                    loading="lazy"
                  />`}
            </button>
            <span class="idx">${i + 1} / ${detail.media.length}</span>
            ${m.nsfwLevel > PG_LEVEL
              ? html`<button
                  class="plain eye"
                  aria-label=${blurred ? 'Show' : 'Hide'}
                  @click=${() => this.#toggleUnblur(m.id)}
                >
                  ${eyeIcon(blurred)}
                </button>`
              : nothing}
          </figure>`;
        })}
      </div>
      ${this.#renderLightbox(detail)}`;
  }

  #renderLightbox(detail: PlannerPostDetail): TemplateResult | typeof nothing {
    const index = this._lightbox;
    if (index == null || !detail.media[index]) return nothing;
    const media = detail.media[index];
    const location = this.host!.config.imageLocation;
    const level = this.host!.config.browsingLevel;
    const blurred = shouldBlur(
      media.nsfwLevel,
      level,
      this._showMature,
      this._unblurred.has(media.id)
    );
    const count = detail.media.length;
    const step = (delta: number) => (this._lightbox = (index + delta + count) % count);
    return html`<civitai-modal
      size="lg"
      heading="${index + 1} / ${count}"
      .open=${true}
      @close=${() => (this._lightbox = null)}
    >
      <div class="lightbox">
        ${media.type === 'video'
          ? html`<video
              class=${blurred ? 'blurred' : ''}
              controls
              autoplay
              muted
              loop
              playsinline
              src=${videoSrc(location, media.url, 1200)}
            ></video>`
          : media.type === 'audio'
          ? html`<p class="muted">Audio item · open the post to listen.</p>`
          : html`<img
              class=${blurred ? 'blurred' : ''}
              src=${mediaSrc(location, media.url, 1200)}
              alt=""
            />`}
        <div class="lightbox-bar">
          <civitai-button variant="subtle" size="sm" ?disabled=${count < 2} @click=${() => step(-1)}
            >‹ Previous</civitai-button
          >
          ${media.nsfwLevel > PG_LEVEL
            ? html`<civitai-button
                variant="outline"
                size="sm"
                @click=${() => this.#toggleUnblur(media.id)}
              >
                ${blurred ? 'Show' : 'Hide'}
              </civitai-button>`
            : nothing}
          <civitai-button variant="subtle" size="sm" ?disabled=${count < 2} @click=${() => step(1)}
            >Next ›</civitai-button
          >
        </div>
      </div>
    </civitai-modal>`;
  }

  #setDraft(date: string | null, time: string | null): void {
    const base = this._draftWhen ?? this._now;
    const next = new Date(base);
    if (date) {
      const [y, m, d] = date.split('-').map(Number);
      next.setFullYear(y, m - 1, d);
    }
    if (time) {
      const [h, min] = time.split(':').map(Number);
      next.setHours(h, min, 0, 0);
    }
    this._draftWhen = next;
  }

  #link(event: Event, loc: PlannerLocation): void {
    // Real hrefs keep middle-click and open-in-new-tab working; a plain click stays in the host.
    const mouse = event as MouseEvent;
    if (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.button === 1) return;
    event.preventDefault();
    this.#navigate(loc);
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

function toDateInput(date: Date): string {
  return localDayKey(date);
}

function toTimeInput(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(
    2,
    '0'
  )}`;
}

function weeksOf<T>(days: T[]): T[][] {
  const weeks: T[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

function mediaSrc(imageLocation: string, key: string, width: number): string {
  return `${imageLocation.replace(/\/$/, '')}/${key}/width=${width}`;
}

/** The delivery URL for a playable video, the shape the main app's EdgeVideo builds. */
function videoSrc(imageLocation: string, key: string, width: number): string {
  return `${imageLocation.replace(
    /\/$/,
    ''
  )}/${key}/anim=true,transcode=true,width=${width}/${key}.mp4`;
}

declare global {
  interface HTMLElementTagNameMap {
    'civitai-post-planner': CivitaiPostPlanner;
  }
}
