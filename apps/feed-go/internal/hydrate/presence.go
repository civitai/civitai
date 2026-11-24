package hydrate

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// The per-entity caches a page's hydration reads, by the label the Go-first probe reports them under
// (`cache` on feed_go_gofirst_miss_total, DESIGN.md "Go-first probe").
const (
	CacheBasicUsers       = "basic-users"
	CacheUserCosmetics    = "user-cosmetics"
	CacheProfilePictures  = "profile-pictures"
	CacheImageFrames      = "image-frames"
	CacheThumbnails       = "thumbnails"
	CacheTagIDs           = "tag-ids"
	CacheEventDecorations = "event-decorations"
	CacheMetrics          = "metrics"
	CacheCosmetics        = "cosmetics"
	CacheImageTags        = "image-tags"
)

// metricHashPrefix is metricHashKey without the `:<id>` (a test pins the two together).
const metricHashPrefix = "metrics:Image"

// PageCache is one per-entity cache Sources.Page reads.
type PageCache struct {
	// Name is the cache's label.
	Name string
	// Key is the key prefix: one key per id, `${Key}:${id}` (a packed entry; for CacheMetrics the
	// watcher-fed hash, which carries no namespace prefix).
	Key string
	// Reason is the fallback reason a miss on this cache raises in Sources.Page WITHOUT a miss
	// computation; "" when Page answers the miss itself (from the replica). With Sources.Compute the
	// caches in MissCaches (misses.go) are answered too: Sources.MissReason is the reason for a
	// given Sources, and the one the probe classifies by.
	Reason string
}

// PageCaches is every per-entity cache Sources.Page reads, in its read order (stage 1, then the
// cosmetic records of stage 2). It is the enumeration the Go-first probe checks (Presence), and the
// tests pin it against Page itself: the keys Presence reads are the keys Page reads, and a miss on
// each cache falls back with this Reason, or is served.
var PageCaches = []PageCache{
	{Name: CacheBasicUsers, Key: KeyBasicUsers},
	{Name: CacheUserCosmetics, Key: KeyUserCosmetics, Reason: "user-cosmetics-miss"},
	{Name: CacheProfilePictures, Key: KeyProfilePictures},
	{Name: CacheImageFrames, Key: KeyImageFrames, Reason: "image-frame-miss"},
	{Name: CacheThumbnails, Key: KeyThumbnails},
	{Name: CacheTagIDs, Key: KeyTagIDs, Reason: "tag-ids-miss"},
	{Name: CacheEventDecorations, Key: KeyImageEvents, Reason: "event-decoration-miss"},
	// Read only for a request with PageRequest.Tags (image.getInfinite's include 'tags').
	{Name: CacheImageTags, Key: KeyImageTags, Reason: "image-tags-miss"},
	{Name: CacheMetrics, Key: metricHashPrefix, Reason: "metrics-miss"},
	{Name: CacheCosmetics, Key: KeyCosmetics},
}

// MissReason is the fallback reason a miss on the named cache raises when s serves: "" for a cache
// s.Compute answers (MissCaches, shared with the miss computation; the metric hashes only when s
// reads ClickHouse); else the PageCaches Reason of a
// page cache, the lookup spec's reason for another computed cache (model-frames), and "" for any
// other name.
func (s *Sources) MissReason(name string) string {
	if name == CacheMetrics {
		// Computed only with a ClickHouse reader (metricsComputed), not by every MissCompute.
		if s.metricsComputed() {
			return ""
		}
		return "metrics-miss"
	}
	if s.Compute != nil && slices.Contains(MissCaches, name) {
		return ""
	}
	if c, ok := PageCacheNamed(name); ok {
		return c.Reason
	}
	return specReason(name)
}

// PageCacheNamed is the PageCaches entry of that name.
func PageCacheNamed(name string) (PageCache, bool) {
	for _, c := range PageCaches {
		if c.Name == name {
			return c, true
		}
	}
	return PageCache{}, false
}

// PresenceResult is one Check: per cache, the ids missing, and the ids present but filled at or
// after the race threshold (raced: most likely by the Node request the probe races, so a Go-first
// serve would have found them missing). Caches with no such id are absent from each map.
type PresenceResult struct {
	Misses map[string]int
	Raced  map[string]int
}

// Presence is Check without the race threshold: the misses only.
func (s *Sources) Presence(ctx context.Context, req PageRequest) (map[string]int, error) {
	r, err := s.Check(ctx, req, time.Time{})
	if err != nil {
		return nil, err
	}
	return r.Misses, nil
}

// Check is the cache half of Page for req without the hydration: which of the per-entity caches
// Page would read for req do not answer an id, and how many ids each misses (caches that miss none
// are absent). It sends the same reads Page sends, read-only: one pipeline of GETs for the packed
// entries and EXISTS for the metric hashes (an absent hash is what HGETALL answers empty), then, as
// Page's stage 2, the GETs of the cosmetic records the present user-cosmetic and frame entries name.
// An entry is present exactly when Page would use it: a `notFound` marker and a stale entry are
// present, a `{debounce: true}` marker or an undecodable value is a miss (decodeEntry). It never
// queries the replica, never writes, and decodes no value beyond what finding the stage-2 ids needs.
//
// A present entry whose fill stamp (a packed entry's `cachedAt`, a metric hash's `_populatedAt`) is
// at or after racedSince counts as raced as well (zero racedSince: no race check). An entry with no
// stamp is never raced; a watcher-fed metric hash carries none.
//
// A read that failed (a shard down, the context ended) is an error: a miss it cannot tell from one.
// Serving fails open on most of these reads (a failed GET is a miss answered from the replica), so
// the probe reports `error` where a serve might have answered.
func (s *Sources) Check(ctx context.Context, req PageRequest, racedSince time.Time) (PresenceResult, error) {
	users, images, videos := Unique(req.UserIDs), Unique(req.ImageIDs), Unique(req.VideoIDs)
	profileUsers := users
	if req.NoProfilePictures {
		profileUsers = nil
	}
	// As Page: the user cosmetics and frames (and so the cosmetic records) only with 'cosmetics'.
	cosmeticUsers, frameImages := users, images
	if req.NoCosmetics {
		cosmeticUsers, frameImages = nil, nil
	}
	stage1 := NewBatch()
	reads := []struct {
		name string
		ids  []int
		read *PackedRead
	}{
		{CacheBasicUsers, users, s.Packed.Queue(stage1, KeyBasicUsers, users, ttlDay)},
		{CacheUserCosmetics, cosmeticUsers, s.Packed.Queue(stage1, KeyUserCosmetics, cosmeticUsers, 0)},
		// As Page: the profile pictures only when the include list asks for them.
		{CacheProfilePictures, profileUsers, s.Packed.Queue(stage1, KeyProfilePictures, profileUsers, 0)},
		{CacheImageFrames, frameImages, s.Packed.Queue(stage1, KeyImageFrames, frameImages, 0)},
		{CacheThumbnails, videos, s.Packed.Queue(stage1, KeyThumbnails, videos, ttlDay)},
		{CacheTagIDs, images, s.Packed.Queue(stage1, KeyTagIDs, images, tagIDsTTL)},
	}
	// As Page: no visible event, no decoration read at all.
	if len(images) > 0 && len(req.VisibleEvents) > 0 {
		reads = append(reads, struct {
			name string
			ids  []int
			read *PackedRead
		}{CacheEventDecorations, images, s.Packed.Queue(stage1, KeyImageEvents, images, 0)})
	}
	// As Page: the votable tags only when the include list asks for them.
	if req.Tags {
		reads = append(reads, struct {
			name string
			ids  []int
			read *PackedRead
		}{CacheImageTags, images, s.Packed.Queue(stage1, KeyImageTags, images, 0)})
	}
	metrics := s.queueMetricsExists(stage1, images)
	stage1.Exec(ctx)

	out := map[string]int{}
	raced := map[string]int{}
	isRaced := func(e Entry) bool {
		return !racedSince.IsZero() && !e.CachedAt.IsZero() && !e.CachedAt.Before(racedSince)
	}
	countRaced := func(name string, entries map[int]Entry) {
		for _, e := range entries {
			if isRaced(e) {
				raced[name]++
			}
		}
	}
	got := map[string]map[int]Entry{}
	for _, r := range reads {
		if err := r.read.readErr(); err != nil {
			return PresenceResult{}, fmt.Errorf("presence %s: %w", r.name, err)
		}
		entries := r.read.Entries()
		if r.name == CacheImageFrames && s.Compute != nil && !s.Compute.FrameNegative {
			// As fillFrames: while frame-cache-negative is off a notFound marker is a miss (Node's
			// fetch ignores markers then), so the lookup runs for it.
			for id, e := range entries {
				if e.NotFound {
					delete(entries, id)
				}
			}
		}
		if r.name == CacheTagIDs && s.Compute != nil {
			// As fillTagIDs: a stale entry (past the cache's ttl, or backdated by a bust) is looked up
			// again. Counted as a miss: with write-back on a serve that finds its revalidation lock
			// held serves it instead, so this can overstate that case's reads.
			for id, e := range entries {
				if e.Stale {
					delete(entries, id)
				}
			}
		}
		got[r.name] = entries
		if n := len(Missing(r.ids, entries)); n > 0 {
			out[r.name] = n
		}
		countRaced(r.name, entries)
	}
	for _, m := range metrics {
		n, err := m.exists.Result()
		if err != nil {
			return PresenceResult{}, fmt.Errorf("presence %s: %w", CacheMetrics, err)
		}
		if n == 0 {
			out[CacheMetrics]++
			continue
		}
		// `_populatedAt` (epoch ms) is written by MetricService's populate, the miss fill.
		if v, err := m.populatedAt.Result(); err == nil && !racedSince.IsZero() {
			if ms, perr := strconv.ParseInt(v, 10, 64); perr == nil && !time.UnixMilli(ms).Before(racedSince) {
				raced[CacheMetrics]++
			}
		} else if err != nil && !errors.Is(err, redis.Nil) {
			return PresenceResult{}, fmt.Errorf("presence %s: %w", CacheMetrics, err)
		}
	}

	// Stage 2 over the entries that ARE present: a missing one already decides its cache, and the
	// cosmetic ids it would name are unknown until it is filled.
	uc, fr := got[CacheUserCosmetics], got[CacheImageFrames]
	_, userCIDs, err := userCosmeticsFrom(keysOf(uc), uc)
	if err != nil {
		return PresenceResult{}, err
	}
	frameCIDs, err := frameCosmeticIDs(keysOf(fr), fr)
	if err != nil {
		return PresenceResult{}, err
	}
	if ids := Unique(append(userCIDs, frameCIDs...)); len(ids) > 0 {
		stage2 := NewBatch()
		read := s.Packed.Queue(stage2, KeyCosmetics, ids, ttlDay)
		stage2.Exec(ctx)
		if err := read.readErr(); err != nil {
			return PresenceResult{}, fmt.Errorf("presence %s: %w", CacheCosmetics, err)
		}
		entries := read.Entries()
		if n := len(Missing(ids, entries)); n > 0 {
			out[CacheCosmetics] = n
		}
		countRaced(CacheCosmetics, entries)
	}
	return PresenceResult{Misses: out, Raced: raced}, nil
}

// readErr is the first failed GET of the lookup other than an absent key, after Exec.
func (r *PackedRead) readErr() error {
	for _, cmd := range r.cmds {
		if err := cmd.Err(); err != nil && !errors.Is(err, redis.Nil) {
			return err
		}
	}
	return nil
}

// metricPresence is one metric hash's presence read: EXISTS, and its `_populatedAt` field.
type metricPresence struct {
	exists      *redis.IntCmd
	populatedAt *redis.StringCmd
}

// queueMetricsExists adds, per metric hash of (unique) ids, an EXISTS and an HGET of `_populatedAt`
// to b, on s.Cache.
func (s *Sources) queueMetricsExists(b *Batch, ids []int) []metricPresence {
	if len(ids) == 0 || s.Cache == nil {
		return nil
	}
	cmds := make([]metricPresence, len(ids))
	b.add(s.Cache, func(ctx context.Context, p redis.Pipeliner) {
		for i, id := range ids {
			cmds[i] = metricPresence{
				exists:      p.Exists(ctx, metricHashKey(id)),
				populatedAt: p.HGet(ctx, metricHashKey(id), "_populatedAt"),
			}
		}
	})
	return cmds
}

func keysOf(m map[int]Entry) []int {
	out := make([]int, 0, len(m))
	for id := range m {
		out = append(out, id)
	}
	return out
}

// PresenceChecker is the cache-presence surface the probe needs (implemented by *Sources): the
// misses and raced entries, and which misses make the page fall back.
type PresenceChecker interface {
	Check(ctx context.Context, req PageRequest, racedSince time.Time) (PresenceResult, error)
	MissReason(name string) string
}

// PresenceProbe stands in for the page hydrator (feed.Hydrator) on a Go-first probe: every Page call
// runs Checker.Presence for its request and accumulates the misses, and answers an EMPTY hydration,
// so the caller resolves its pages exactly as it does when serving (the ids a page holds come from
// the page query, never from a hydrated value) while nothing is hydrated, queried for a miss or
// written. VisibleModel3DIDs answers no model as visible, without a query. Safe for concurrent use
// (a page's post completions call Page concurrently).
type PresenceProbe struct {
	Checker PresenceChecker
	// Now is the clock FirstCheck reads (nil: time.Now).
	Now func() time.Time
	// RacedSince is the race threshold handed to every Check (zero: no race check).
	RacedSince time.Time

	mu      sync.Mutex
	misses  map[string]int
	raced   map[string]int
	dbReads map[string]int
	first   time.Time
	pages   int
}

// Page records req's cache presence and returns an empty hydration.
func (p *PresenceProbe) Page(ctx context.Context, req PageRequest) (*Page, error) {
	p.notePage()
	res, err := p.Checker.Check(ctx, req, p.RacedSince)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.misses == nil {
		p.misses, p.raced, p.dbReads = map[string]int{}, map[string]int{}, map[string]int{}
	}
	// A miss or a raced entry on a cache Go answers itself: one database query for this cache on this
	// page (the replica path's, or the miss computation's batched lookup). A raced entry was most
	// likely filled by the Node request the probe races, so a Go-first serve would have looked it up
	// with the misses; a cache both missed and raced on this page is one batched lookup, counted once.
	read := map[string]bool{}
	for name, n := range res.Misses {
		p.misses[name] += n
		if n > 0 {
			read[name] = true
		}
	}
	for name, n := range res.Raced {
		p.raced[name] += n
		if n > 0 {
			read[name] = true
		}
	}
	for name := range read {
		if p.Checker.MissReason(name) == "" {
			p.dbReads[name]++
		}
	}
	return &Page{}, nil
}

// notePage counts one page whose cache reads begin now (the first one's start is FirstCheck's).
func (p *PresenceProbe) notePage() {
	now := time.Now
	if p.Now != nil {
		now = p.Now
	}
	started := now()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.first.IsZero() {
		p.first = started
	}
	p.pages++
}

// recordComputed records n missed ids of cache, a cache Go computes, and the one lookup query that
// answers them (a page's batched lookup).
func (p *PresenceProbe) recordComputed(cache string, n int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.misses == nil {
		p.misses, p.raced, p.dbReads = map[string]int{}, map[string]int{}, map[string]int{}
	}
	p.misses[cache] += n
	p.dbReads[cache]++
}

type presenceKey struct{}

// WithPresence is ctx for a Go-first probe that runs a serving path itself (model.getAll, whose
// hydration is not the page hydrator PresenceProbe stands in for): under it a miss the computation
// would answer (Sources.fill) is recorded on p, its ids and one database read, and answered as no
// entry, never looked up or written (a version showcase miss is looked up, on the replica, as its
// answer decides the page's rows: lookupSpec.probeLooksUp); and each model page (ModelPage) counts as
// a page checked. A cache Go falls back on still falls back.
func WithPresence(ctx context.Context, p *PresenceProbe) context.Context {
	return context.WithValue(ctx, presenceKey{}, p)
}

func presenceOf(ctx context.Context) *PresenceProbe {
	p, _ := ctx.Value(presenceKey{}).(*PresenceProbe)
	return p
}

// VisibleModel3DIDs answers no linked model as visible (it changes a field, never which ids a page
// holds).
func (p *PresenceProbe) VisibleModel3DIDs(context.Context, []int, int, bool) (map[int]bool, error) {
	return map[int]bool{}, nil
}

// Misses is the missed-id count per cache over every Page call so far (a copy).
func (p *PresenceProbe) Misses() map[string]int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return copyCounts(p.misses)
}

// Raced is the raced-entry count per cache over every Page call so far (a copy).
func (p *PresenceProbe) Raced() map[string]int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return copyCounts(p.raced)
}

// DBReads is, per cache, the database queries a Go-first serve would have made for the misses and
// raced entries of the caches Go answers itself (one per page and cache with such a miss or raced
// entry, once when both; a lower bound: the user-cosmetics and
// frame computations can add up to two withheld-cosmetic queries, the tag-ids one a tag query for
// the tags the basic-tags cache misses).
func (p *PresenceProbe) DBReads() map[string]int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return copyCounts(p.dbReads)
}

func copyCounts(m map[string]int) map[string]int {
	out := make(map[string]int, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// FirstCheck is when the first Page call began its cache reads, and the number of Page calls; zero
// time when there was none (the request never reached hydration).
func (p *PresenceProbe) FirstCheck() (time.Time, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.first, p.pages
}
