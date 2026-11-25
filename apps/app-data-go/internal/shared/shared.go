// Package shared answers reads of SHARED collections (WRITES-DESIGN.md, "The read path", as the
// generic core simplified it: docs/app-storage-generic-core.md, "Registry and app-data-go impact").
// A read is the union of two kinds of stream on the registry adapter:
//
//   - LEVEL STREAMS, one per (collection major, level bit), read under this service's own service
//     token and shared by every viewer (src/server/registry-adapter/level-feed.ts). The five
//     selectable bits partition the rated board; with content levels off for the app there is one
//     stream, `none`, of every visible document. Each entity is a plain document: key, data,
//     version, timestamps and seq, never an author.
//   - the PER-VIEWER STREAM, one per (viewer token, collection major), read under the token
//     exchanged from the viewer's own token, like a private stream: every document of the
//     collection the viewer authored, at every rating state REST shows its author. Its `meta` names
//     the viewer's level MASK (decided by the adapter, never here) and the collection's `keyedBy`.
//     It is the gate: a `live` or `progress` that names no mask is the adapter refusing the viewer,
//     and every read of theirs is ErrViewerRefused, from every level stream at once.
//
// THE UNION. The level streams whose bit is in the mask, plus the viewer's own documents, ordered by
// key and DEDUPLICATED BY KEY, keeping the higher seq (a re-rating moves a document between bits,
// and two streams may briefly both hold it). A document is the viewer's own (author.isViewer) when
// the per-viewer stream holds its key.
//
// THE MODE. Whether content levels are on for the app is the adapter's to say: a bit stream ends
// `levels_off` when they are off, and `none` ends `levels_on` when they are on. A read starts in
// the per-bit shape (fail closed, as an unreadable flag counts as on), switches on either end, and
// remembers the mode for the schema for modeTTL; the per-viewer stream's `levels` names it too.
//
// SIGNED-OUT. A signed-out viewer (an anonymous block token, verified by the caller) reads the level
// streams alone, at the mask the caller computed from the token's own claims (ViewerLevel), and only
// while every level stream it reads names the token's app block as the slug's approved production
// block (`meta.block`). No per-viewer stream, no authorship, no overlays: it cannot write.
//
// A signed-out read opens no stream for a collection major this replica has not KNOWN to resolve
// (Known) until one probe has: a single level stream, the first its read needs, and the rest only
// once that one reached `Live`. A level stream reaches `Live` only when the adapter resolved its
// schema (an approved app, a collection its manifest declares shared, a minted major; level-feed.ts
// `advance` ends it `not_resolved` otherwise), so a made-up collection or major costs one stream,
// which the adapter ends at once. At most ProbesPerApp probes run at once per slug; a read past that
// is ErrSignedOutBusy. The check is the adapter's: this service holds no catalog.
//
// THE SERVICE TOKEN. A level stream refused `invalid_token` is this service's own token refused, never
// the viewer's: the read is ErrServiceToken (a 503, not a 401), and the level manager re-mints the
// token (session.Options.InvalidToken).
//
// READ-YOUR-WRITES. Each write the store acknowledged for a token (Ack) is an overlay over that
// token's union, by key, at the write's seq: a record, or a delete marker. An overlay is applied only
// above the union's own seq for its key, and dropped once every stream the read used names a head at
// or above it (each poll's head covers every write at or below it), or OverlayTTL after it was set.
// A floor (minSeq) is met when that lowest head is at or above it or, for a block token only, by an
// overlay this replica holds for the token; otherwise the read is ErrFloorNotMet. A shared read never
// reopens a stream for a floor: the level streams are every viewer's, and reopening them per viewer
// is a full re-read of the board.
//
// THE WINDOW. A level stream past its bound keeps its newest documents by key and says so
// (`meta.truncated`); below its lowest key the union is not known. Board.Floor is the highest such
// key over the streams read: a get or a page that needs what lies below it is ErrOutsideWindow.
package shared

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/urn"
)

// Views answers a stream's records and meta (session.Manager.View).
type Views interface {
	View(ctx context.Context, token, schema string, minSeq int64) (session.Snapshot, error)
}

// LevelBits are the selectable content levels, one level stream each (level-feed.ts
// LEVEL_STREAM_BITS): PG, PG-13, R, X, XXX.
var LevelBits = []int64{1, 2, 4, 8, 16}

// selectable is every bit of LevelBits.
const selectable = 31

// Why a shared read is not answered.
var (
	// ErrViewerRefused: the per-viewer stream names no mask (the adapter refused the viewer).
	ErrViewerRefused = errors.New("shared: the origin refused this viewer")
	// ErrBlockMismatch: a signed-out token's app block is not the one the level streams name.
	ErrBlockMismatch = errors.New("shared: the token's app block is not the slug's approved block")
	// ErrUnkeyed: a stream sent an entity without its key, so it cannot be ordered or deduplicated.
	ErrUnkeyed = errors.New("shared: a stream's entity carries no key")
	// ErrOutsideWindow: the answer needs documents below a truncated level stream's window.
	ErrOutsideWindow = errors.New("shared: the answer lies outside a level stream's window")
	// ErrSignInRequired: a signed-out viewer asked for what only a signed-in one has.
	ErrSignInRequired = errors.New("shared: sign in required")
	// ErrServiceToken: the registry refused this service's own token on a level stream.
	ErrServiceToken = errors.New("shared: the registry refused the service token")
	// ErrSignedOutBusy: the slug already has ProbesPerApp signed-out probes running.
	ErrSignedOutBusy = errors.New("shared: too many signed-out reads of unknown collections at once")
)

// The level-stream subscription subject: `level:<bit|none>|<schema>`. It keys the level manager's
// streams (one per schema and level, shared by every viewer) and names the subscription's meta.
const levelSubjectPrefix = "level:"

// LevelSubject is the level manager's subject for schema's level (a bit, or "none").
func LevelSubject(schema, level string) string { return levelSubjectPrefix + level + "|" + schema }

// LevelMeta is the request meta a level subject subscribes with (session.Options.SubscribeMeta):
// `{"level":<bit>}` or `{"level":"none"}`. Nil for any other subject.
func LevelMeta(subject string) json.RawMessage {
	rest, ok := strings.CutPrefix(subject, levelSubjectPrefix)
	if !ok {
		return nil
	}
	level, _, ok := strings.Cut(rest, "|")
	switch {
	case !ok:
		return nil
	case level == "none":
		return json.RawMessage(`{"level":"none"}`)
	}
	for _, b := range LevelBits {
		if level == strconv.FormatInt(b, 10) {
			return json.RawMessage(`{"level":` + level + `}`)
		}
	}
	return nil
}

// boundCursorRE is the adapter's wrapping of every cursor (subscription.ts bindCursor).
var boundCursorRE = regexp.MustCompile(`^b1\.[0-9a-f]{24}\.(.+)$`)

// innerCursor reports whether cursor, as the adapter sent it, wraps one starting prefix.
func innerCursor(cursor, prefix string) bool {
	m := boundCursorRE.FindStringSubmatch(cursor)
	return m != nil && strings.HasPrefix(m[1], prefix)
}

// AcceptLevel is the level manager's session.Options.Accept: the level feed's `l1.` cursors.
func AcceptLevel(cursor string) bool { return innerCursor(cursor, "l1.") }

// AcceptViewer is the per-viewer manager's session.Options.Accept: the per-viewer feed's `v1.`.
func AcceptViewer(cursor string) bool { return innerCursor(cursor, "v1.") }

// ViewerLevel is the site's resolveViewerBrowsingLevel (src/server/services/blocks/
// block-viewer-ceiling.ts) of a block token's two claims: the domain ceiling intersected with the
// viewer's own level, held to the selectable levels; PG when the ceiling is absent, the viewer level
// absent or negative counts as PG, and an empty intersection is PG. A signed-out viewer's mask.
func ViewerLevel(maxBrowsingLevel, viewerBrowsingLevel *int64) int64 {
	if maxBrowsingLevel == nil {
		return 1
	}
	viewer := int64(1)
	if viewerBrowsingLevel != nil && *viewerBrowsingLevel >= 0 {
		viewer = *viewerBrowsingLevel
	}
	if l := *maxBrowsingLevel & viewer & selectable; l != 0 {
		return l
	}
	return 1
}

// Doc is one document of a shared read.
type Doc struct {
	URN, Key, Rev        string
	Data                 json.RawMessage
	Version              int64
	CreatedAt, UpdatedAt string
	Seq                  int64
	// Mine: the viewer authored it (the per-viewer stream holds its key, or it is their own write).
	Mine bool
}

// Board is a shared read's answer.
type Board struct {
	// Docs are every document the viewer sees, sorted by key, each key once.
	Docs []Doc
	// Floor is the highest lowest-key of a truncated level stream read: below it the board is not
	// known. "" when no stream read is truncated.
	Floor string
	// KeyedBy is the collection's `keyedBy` as the per-viewer stream names it ("" for none, and for a
	// signed-out read).
	KeyedBy string
}

// Viewer is who reads.
type Viewer struct {
	// Token is the viewer's bearer token: the per-viewer stream's, and the overlays' key.
	Token string
	// Anonymous, when set, is a signed-out read: no per-viewer stream, at this mask, for this block.
	Anonymous *Anonymous
}

// Anonymous is a signed-out viewer, from its verified block token.
type Anonymous struct {
	Mask       int64
	AppBlockID string
}

// modeTTL is how long a schema's levels mode, once learned, is remembered.
const modeTTL = 10 * time.Minute

// Reader answers shared reads.
type Reader struct {
	Levels  Views
	Viewers Views
	// Overlays holds the acknowledged writes; nil is none (the writes off).
	Overlays *Overlays
	// KnownTTL is how long a schema whose level stream reached Live stays Known: at least a level
	// stream's own MaxAge, so a schema is Known while any of its level streams is open.
	KnownTTL time.Duration
	// ProbesPerApp bounds the signed-out probes running at once per slug (see SIGNED-OUT).
	ProbesPerApp int
	// Now is the clock; nil is time.Now.
	Now func() time.Time

	mu     sync.Mutex
	off    map[string]time.Time // schemas known in levels-off mode, until
	known  map[string]time.Time // schemas a level stream of resolved, until
	probes map[string]int       // signed-out probes running, per slug
}

func (r *Reader) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Read answers the board of one shared collection major for v. minSeq > 0 is the read's floor.
func (r *Reader) Read(ctx context.Context, v Viewer, slug, collection string, major int, minSeq int64) (Board, error) {
	schema, err := urn.CollectionSchema(slug, collection, major)
	if err != nil {
		return Board{}, err
	}
	var views []session.Snapshot
	var own session.Snapshot
	var meta viewerMeta
	mask := int64(0)
	if v.Anonymous != nil {
		mask = v.Anonymous.Mask & selectable
	} else {
		vschema, err := urn.ViewerSchema(slug, collection, major)
		if err != nil {
			return Board{}, err
		}
		own, err = r.Viewers.View(ctx, v.Token, vschema, 0)
		if err != nil {
			return Board{}, err
		}
		meta = readViewerMeta(own.Meta)
		if meta.Mask == nil {
			return Board{}, ErrViewerRefused
		}
		mask = *meta.Mask & selectable
		switch meta.Levels {
		case "off":
			r.setOff(schema, true)
		case "on":
			r.setOff(schema, false)
		}
	}
	probeSlug := ""
	if v.Anonymous != nil {
		probeSlug = slug
	}
	views, err = r.levels(ctx, schema, mask, probeSlug)
	if err != nil {
		return Board{}, err
	}
	if v.Anonymous != nil {
		for _, lv := range views {
			if readLevelMeta(lv.Meta).Block != v.Anonymous.AppBlockID || v.Anonymous.AppBlockID == "" {
				return Board{}, ErrBlockMismatch
			}
		}
	}

	byKey := map[string]Doc{}
	add := func(e registry.Entity, mine bool) error {
		if e.Key == "" {
			return ErrUnkeyed
		}
		prev, had := byKey[e.Key]
		d := docOf(e, mine || (had && prev.Mine))
		if !had || e.Seq > prev.Seq {
			byKey[e.Key] = d
		} else if mine {
			prev.Mine = true
			byKey[e.Key] = prev
		}
		return nil
	}
	board := Board{KeyedBy: meta.KeyedBy}
	// low is the lowest head among the streams read; known only when every one of them named one.
	low, read, headless := int64(0), 0, false
	head := func(s session.Snapshot) {
		switch {
		case !s.HasHead:
			headless = true
		case read == 0 || s.Head < low:
			low = s.Head
		}
		read++
	}
	for _, lv := range views {
		head(lv)
		lowest := ""
		for _, e := range lv.Entities {
			if err := add(e, false); err != nil {
				return Board{}, err
			}
			if lowest == "" || e.Key < lowest {
				lowest = e.Key
			}
		}
		if readLevelMeta(lv.Meta).Truncated && lowest > board.Floor {
			board.Floor = lowest
		}
	}
	if v.Anonymous == nil {
		head(own)
		for _, e := range own.Entities {
			if err := add(e, true); err != nil {
				return Board{}, err
			}
		}
	}
	lowKnown := read > 0 && !headless
	held := int64(0)
	if v.Anonymous == nil && r.Overlays != nil {
		held = r.Overlays.apply(v.Token, schema, byKey, low, lowKnown, r.now())
	}
	// A stream that names no head cannot be compared with a floor: unfloored, as a private read.
	if minSeq > 0 && lowKnown && low < minSeq {
		if held < minSeq || exchange.KindOf(v.Token) != exchange.KindBlock {
			return Board{}, session.ErrFloorNotMet
		}
	}
	board.Docs = make([]Doc, 0, len(byKey))
	for _, d := range byKey {
		board.Docs = append(board.Docs, d)
	}
	slices.SortFunc(board.Docs, func(a, b Doc) int { return strings.Compare(a.Key, b.Key) })
	return board, nil
}

// levels reads the level streams of schema for mask, in the schema's mode, switching mode once when
// a stream's end says it is the other. probeSlug, set for a signed-out read, reads a schema not Known
// by one probe first (SIGNED-OUT).
func (r *Reader) levels(ctx context.Context, schema string, mask int64, probeSlug string) ([]session.Snapshot, error) {
	views, err := r.levelsOnce(ctx, schema, mask, probeSlug)
	if errors.Is(err, session.ErrInvalidToken) {
		// The level streams' token is this service's (THE SERVICE TOKEN); never the viewer's 401.
		return nil, ErrServiceToken
	}
	if err == nil {
		r.markKnown(schema)
	}
	return views, err
}

func (r *Reader) levelsOnce(ctx context.Context, schema string, mask int64, probeSlug string) ([]session.Snapshot, error) {
	if probeSlug != "" && !r.Known(schema) {
		release, ok := r.probe(probeSlug)
		if !ok {
			return nil, ErrSignedOutBusy
		}
		_, err := r.readModes(ctx, schema, mask, true)
		release()
		if err != nil {
			return nil, err
		}
		r.markKnown(schema)
	}
	return r.readModes(ctx, schema, mask, false)
}

// readModes is the mode-switching read of levels; first reads only the first subject (a probe).
func (r *Reader) readModes(ctx context.Context, schema string, mask int64, first bool) ([]session.Snapshot, error) {
	for switched := false; ; switched = true {
		off := r.isOff(schema)
		var subjects []string
		if off {
			subjects = []string{LevelSubject(schema, "none")}
		} else {
			for _, b := range LevelBits {
				if mask&b != 0 {
					subjects = append(subjects, LevelSubject(schema, strconv.FormatInt(b, 10)))
				}
			}
		}
		if first && len(subjects) > 1 {
			subjects = subjects[:1]
		}
		views, err := r.readAll(ctx, schema, subjects)
		var ended *session.EndedError
		if !switched && errors.As(err, &ended) && (ended.Reason == "levels_off" && !off || ended.Reason == "levels_on" && off) {
			r.setOff(schema, !off)
			continue
		}
		return views, err
	}
}

// readAll reads every subject at once (a new level stream's first read waits for its snapshot); the
// first error in subject order is the read's.
func (r *Reader) readAll(ctx context.Context, schema string, subjects []string) ([]session.Snapshot, error) {
	views := make([]session.Snapshot, len(subjects))
	errs := make([]error, len(subjects))
	var wg sync.WaitGroup
	for i, subject := range subjects {
		wg.Add(1)
		go func() {
			defer wg.Done()
			views[i], errs[i] = r.Levels.View(ctx, subject, schema, 0)
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return views, nil
}

// Known reports whether a level stream of schema reached Live within KnownTTL: the adapter resolved
// it as a shared collection major.
func (r *Reader) Known(schema string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	until, ok := r.known[schema]
	return ok && r.now().Before(until)
}

func (r *Reader) markKnown(schema string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.known == nil {
		r.known = map[string]time.Time{}
	}
	now := r.now()
	for k, until := range r.known {
		if !now.Before(until) {
			delete(r.known, k)
		}
	}
	r.known[schema] = now.Add(r.KnownTTL)
}

// probe takes one of slug's signed-out probes, and the func that gives it back; false when slug has
// ProbesPerApp running.
func (r *Reader) probe(slug string) (func(), bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.probes == nil {
		r.probes = map[string]int{}
	}
	if r.probes[slug] >= r.ProbesPerApp {
		return nil, false
	}
	r.probes[slug]++
	return func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.probes[slug]--; r.probes[slug] <= 0 {
			delete(r.probes, slug)
		}
	}, true
}

func (r *Reader) isOff(schema string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	until, ok := r.off[schema]
	return ok && r.now().Before(until)
}

func (r *Reader) setOff(schema string, off bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.off == nil {
		r.off = map[string]time.Time{}
	}
	now := r.now()
	for k, until := range r.off {
		if !now.Before(until) {
			delete(r.off, k)
		}
	}
	if off {
		r.off[schema] = now.Add(modeTTL)
	} else {
		delete(r.off, schema)
	}
}

func docOf(e registry.Entity, mine bool) Doc {
	return Doc{URN: e.URN, Key: e.Key, Rev: e.Rev, Data: e.Body, Version: e.Version, CreatedAt: e.CreatedAt,
		UpdatedAt: e.UpdatedAt, Seq: e.Seq, Mine: mine}
}

// viewerMeta is what a per-viewer stream's meta names.
type viewerMeta struct {
	Mask    *int64
	Levels  string
	KeyedBy string
}

func readViewerMeta(raw json.RawMessage) viewerMeta {
	var m struct {
		Mask    *int64 `json:"mask"`
		Levels  string `json:"levels"`
		KeyedBy string `json:"keyedBy"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &m) != nil {
		return viewerMeta{}
	}
	if m.Mask != nil && (*m.Mask < 0 || *m.Mask > selectable) {
		m.Mask = nil
	}
	if m.KeyedBy != "viewer" && m.KeyedBy != "parent+viewer" {
		m.KeyedBy = ""
	}
	return viewerMeta{Mask: m.Mask, Levels: m.Levels, KeyedBy: m.KeyedBy}
}

// levelMeta is what a level stream's meta names (level-feed.ts levelMeta).
type levelMeta struct {
	Block     string
	Truncated bool
}

func readLevelMeta(raw json.RawMessage) levelMeta {
	var m struct {
		Block     string `json:"block"`
		Truncated bool   `json:"truncated"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &m) != nil {
		return levelMeta{}
	}
	return levelMeta{Block: m.Block, Truncated: m.Truncated}
}

// Overlays holds each token's acknowledged writes to shared collections, by (token, schema) and key.
// Bounded: past Max overlays or MaxBytes of them in all, a write is not overlaid (its streams show it
// at their next poll).
type Overlays struct {
	// TTL is how long an overlay lives: one adapter poll plus 30 s.
	TTL time.Duration
	// Max bounds the overlays held in all, and MaxBytes their size (ackSize; zero: no byte bound).
	Max, MaxBytes int
	// Now is the clock; nil is time.Now.
	Now func() time.Time

	mu    sync.Mutex
	n     int
	bytes int
	byKey map[overlayKey]map[string]overlay
}

// ackSize is what one overlay counts against Overlays.MaxBytes.
func ackSize(a session.Ack) int {
	return len(a.Key) + len(a.URN) + len(a.Body) + len(a.CreatedAt) + len(a.UpdatedAt)
}

type overlayKey struct {
	token  [32]byte
	schema string
}

type overlay struct {
	ack   session.Ack
	until time.Time
}

func tokenHash(token string) [32]byte { return sha256.Sum256([]byte(token)) }

func (o *Overlays) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

// Ack records one write the store acknowledged for token in schema. An ack without a seq or a key,
// or older than the overlay held for its key, is ignored.
func (o *Overlays) Ack(token, schema string, a session.Ack) {
	if a.Seq <= 0 || a.Key == "" || o.TTL <= 0 {
		return
	}
	k := overlayKey{token: tokenHash(token), schema: schema}
	now := o.now()
	o.mu.Lock()
	defer o.mu.Unlock()
	o.sweepLocked(now)
	held := o.byKey[k]
	prev, had := held[a.Key]
	if had && prev.ack.Seq > a.Seq {
		return
	}
	if !had && o.n >= o.Max {
		return
	}
	n := o.bytes + ackSize(a)
	if had {
		n -= ackSize(prev.ack)
	}
	if o.MaxBytes > 0 && n > o.MaxBytes {
		return
	}
	o.bytes = n
	if held == nil {
		if o.byKey == nil {
			o.byKey = map[overlayKey]map[string]overlay{}
		}
		held = map[string]overlay{}
		o.byKey[k] = held
	}
	if !had {
		o.n++
	}
	held[a.Key] = overlay{ack: a, until: now.Add(o.TTL)}
}

// sweepLocked drops every expired overlay. o.mu is held.
func (o *Overlays) sweepLocked(now time.Time) {
	for k, held := range o.byKey {
		for key, ov := range held {
			if !now.Before(ov.until) {
				delete(held, key)
				o.n--
				o.bytes -= ackSize(ov.ack)
			}
		}
		if len(held) == 0 {
			delete(o.byKey, k)
		}
	}
}

// Len is how many overlays are held.
func (o *Overlays) Len() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.n
}

// apply lays token's overlays of schema over byKey and answers the highest seq among those it
// applied (for the floor). An overlay at or below the union's seq for its key, or at or below head
// when headKnown (every stream read named a head), is caught up and dropped.
func (o *Overlays) apply(token, schema string, byKey map[string]Doc, head int64, headKnown bool, now time.Time) int64 {
	k := overlayKey{token: tokenHash(token), schema: schema}
	o.mu.Lock()
	defer o.mu.Unlock()
	held := o.byKey[k]
	top := int64(0)
	for key, ov := range held {
		base, hasBase := byKey[key]
		if !now.Before(ov.until) || (headKnown && ov.ack.Seq <= head) || (hasBase && base.Seq >= ov.ack.Seq) {
			delete(held, key)
			o.n--
			o.bytes -= ackSize(ov.ack)
			continue
		}
		top = max(top, ov.ack.Seq)
		if ov.ack.Deleted {
			delete(byKey, key)
			continue
		}
		byKey[key] = Doc{URN: ov.ack.URN, Key: key, Rev: "seq." + strconv.FormatInt(ov.ack.Seq, 10), Data: ov.ack.Body,
			Version: ov.ack.Version, CreatedAt: ov.ack.CreatedAt, UpdatedAt: ov.ack.UpdatedAt, Seq: ov.ack.Seq, Mine: true}
	}
	if len(held) == 0 {
		delete(o.byKey, k)
	}
	return top
}
