package hydrate

import (
	"context"
	"errors"
	"fmt"
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
	{Name: CacheMetrics, Key: metricHashPrefix, Reason: "metrics-miss"},
	{Name: CacheCosmetics, Key: KeyCosmetics},
}

// MissReason is the fallback reason a miss on the named page cache raises in s.Page: the PageCaches
// Reason, or "" for a cache s.Compute answers (MissCaches, shared with the miss computation) and for
// a name that is not a page cache.
func (s *Sources) MissReason(name string) string {
	c, ok := PageCacheNamed(name)
	if !ok {
		return ""
	}
	if s.Compute != nil {
		for _, m := range MissCaches {
			if m == name {
				return ""
			}
		}
	}
	return c.Reason
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

// Presence is the cache half of Page for req without the hydration: which of the per-entity caches
// Page would read for req do not answer an id, and how many ids each misses (caches that miss none
// are absent). It sends the same reads Page sends, read-only: one pipeline of GETs for the packed
// entries and EXISTS for the metric hashes (an absent hash is what HGETALL answers empty), then, as
// Page's stage 2, the GETs of the cosmetic records the present user-cosmetic and frame entries name.
// An entry is present exactly when Page would use it: a `notFound` marker and a stale entry are
// present, a `{debounce: true}` marker or an undecodable value is a miss (decodeEntry). It never
// queries the replica, never writes, and decodes no value beyond what finding the stage-2 ids needs.
//
// A read that failed (a shard down, the context ended) is an error: a miss it cannot tell from one.
func (s *Sources) Presence(ctx context.Context, req PageRequest) (map[string]int, error) {
	users, images, videos := Unique(req.UserIDs), Unique(req.ImageIDs), Unique(req.VideoIDs)
	profileUsers := users
	if req.NoProfilePictures {
		profileUsers = nil
	}
	stage1 := NewBatch()
	reads := []struct {
		name string
		ids  []int
		read *PackedRead
	}{
		{CacheBasicUsers, users, s.Packed.Queue(stage1, KeyBasicUsers, users, ttlDay)},
		{CacheUserCosmetics, users, s.Packed.Queue(stage1, KeyUserCosmetics, users, 0)},
		// As Page: the profile pictures only when the include list asks for them.
		{CacheProfilePictures, profileUsers, s.Packed.Queue(stage1, KeyProfilePictures, profileUsers, 0)},
		{CacheImageFrames, images, s.Packed.Queue(stage1, KeyImageFrames, images, 0)},
		{CacheThumbnails, videos, s.Packed.Queue(stage1, KeyThumbnails, videos, ttlDay)},
		{CacheTagIDs, images, s.Packed.Queue(stage1, KeyTagIDs, images, 0)},
	}
	// As Page: no visible event, no decoration read at all.
	if len(images) > 0 && len(req.VisibleEvents) > 0 {
		reads = append(reads, struct {
			name string
			ids  []int
			read *PackedRead
		}{CacheEventDecorations, images, s.Packed.Queue(stage1, KeyImageEvents, images, 0)})
	}
	metrics := s.queueMetricsExists(stage1, images)
	stage1.Exec(ctx)

	out := map[string]int{}
	got := map[string]map[int]Entry{}
	for _, r := range reads {
		if err := r.read.readErr(); err != nil {
			return nil, fmt.Errorf("presence %s: %w", r.name, err)
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
		got[r.name] = entries
		if n := len(Missing(r.ids, entries)); n > 0 {
			out[r.name] = n
		}
	}
	for _, cmd := range metrics {
		n, err := cmd.Result()
		if err != nil {
			return nil, fmt.Errorf("presence %s: %w", CacheMetrics, err)
		}
		if n == 0 {
			out[CacheMetrics]++
		}
	}

	// Stage 2 over the entries that ARE present: a missing one already decides its cache, and the
	// cosmetic ids it would name are unknown until it is filled.
	uc, fr := got[CacheUserCosmetics], got[CacheImageFrames]
	_, userCIDs, err := userCosmeticsFrom(keysOf(uc), uc)
	if err != nil {
		return nil, err
	}
	frameCIDs, err := frameCosmeticIDs(keysOf(fr), fr)
	if err != nil {
		return nil, err
	}
	if ids := Unique(append(userCIDs, frameCIDs...)); len(ids) > 0 {
		stage2 := NewBatch()
		read := s.Packed.Queue(stage2, KeyCosmetics, ids, ttlDay)
		stage2.Exec(ctx)
		if err := read.readErr(); err != nil {
			return nil, fmt.Errorf("presence %s: %w", CacheCosmetics, err)
		}
		if n := len(Missing(ids, read.Entries())); n > 0 {
			out[CacheCosmetics] = n
		}
	}
	return out, nil
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

// queueMetricsExists adds one EXISTS per metric hash of (unique) ids to b, on s.Cache.
func (s *Sources) queueMetricsExists(b *Batch, ids []int) []*redis.IntCmd {
	if len(ids) == 0 || s.Cache == nil {
		return nil
	}
	cmds := make([]*redis.IntCmd, len(ids))
	b.add(s.Cache, func(ctx context.Context, p redis.Pipeliner) {
		for i, id := range ids {
			cmds[i] = p.Exists(ctx, metricHashKey(id))
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
// misses, and which of them make the page fall back.
type PresenceChecker interface {
	Presence(ctx context.Context, req PageRequest) (map[string]int, error)
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

	mu     sync.Mutex
	misses map[string]int
	first  time.Time
	pages  int
}

// Page records req's cache presence and returns an empty hydration.
func (p *PresenceProbe) Page(ctx context.Context, req PageRequest) (*Page, error) {
	now := time.Now
	if p.Now != nil {
		now = p.Now
	}
	started := now()
	p.mu.Lock()
	if p.first.IsZero() {
		p.first = started
	}
	p.pages++
	p.mu.Unlock()
	misses, err := p.Checker.Presence(ctx, req)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.misses == nil {
		p.misses = map[string]int{}
	}
	for name, n := range misses {
		p.misses[name] += n
	}
	return &Page{}, nil
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
	out := make(map[string]int, len(p.misses))
	for k, v := range p.misses {
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
