package profanity

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// The lists profaneSearchCheck enforces, and where Node reads them:
//
//   - Flag `profanity-managed-list` (isFlipt, boolean, no context). OFF: the shipped block list with
//     obscenity's English dataset, allowing the ProfanityBenignWord row's words (its `data` when the
//     row has an `id`, else the shipped allow list). ON: the ProfanityWord row's usable entries
//     (managedProfanityEntries) when at least MIN_MANAGED_PROFANITY_ENTRIES distinct ones remain, else
//     the shipped block list; either way allowing the ProfanityBenignWord row as above.
//   - Each row through readBlocklistWithSource: the cache cluster's `system:blocklist:<type>` (Node's
//     cache prefix included), a JSON BlocklistDTO the Node app, the moderator spoke and the auth hub
//     write for 5 minutes from the database row and delete on every write; on a miss the database.
//
// This reads the same keys with the same client prefix, and nothing else: a miss, an unreadable key, a
// value not shaped as a DTO, an unknown flag, a list that will not build, or a block entry outside
// ASCII is Unproven, never clean. Node's own failure paths (its last good list while its read fails,
// the shipped list when its check throws) are not reproduced: they are what Node does when ITS reads
// fail, which this process cannot see.

// Blocklist types (BlocklistType in src/server/common/enums.ts) and the cache key Node reads them
// under (REDIS_KEYS.SYSTEM.BLOCKLIST, `${key}:${type}`).
const (
	TypeBlocked = "ProfanityWord"
	TypeBenign  = "ProfanityBenignWord"
	KeyPrefix   = "system:blocklist:"
)

// Flag is the `profanity-managed-list` flag's state (flipt.Switch): On, Off (known off), or neither
// (never read, or unread past its staleness bound), which is Unproven.
type Flag interface {
	On() bool
	Off() bool
}

// Getter is the part of the cache-cluster client the check reads.
type Getter interface {
	Get(ctx context.Context, key string) *redis.StringCmd
}

// Verdict is a check's answer.
type Verdict string

const (
	Clean   Verdict = "clean"
	Profane Verdict = "profane"
	// Unproven: the check could not prove the answer Node gives. Hand the request back.
	Unproven Verdict = "unproven"
)

// Result is a verdict and, when Unproven, why (a metric label).
type Result struct {
	Verdict Verdict
	Reason  string
}

// Unproven reasons.
const (
	ReasonUnconfigured = "unconfigured" // no checker, no cache client or no flag
	ReasonText         = "text"         // a query outside ASCII (ErrUnproven)
	ReasonTextLength   = "text-length"  // a query longer than MaxQueryBytes
	ReasonFlag         = "flag"         // the flag's state is not known
	ReasonListMiss     = "list-miss"    // a row's cache key is absent (Node reads the database)
	ReasonListRead     = "list-read"    // the cache read failed
	ReasonListShape    = "list-shape"   // the cached value is not a BlocklistDTO of strings
	ReasonListBuild    = "list-build"   // the lists do not build (or hold a non-ASCII block entry)
)

// UnprovenReasons are every Unproven reason, for seeding.
var UnprovenReasons = []string{ReasonUnconfigured, ReasonText, ReasonTextLength, ReasonFlag,
	ReasonListMiss, ReasonListRead, ReasonListShape, ReasonListBuild}

// MaxQueryBytes bounds the text one query may carry for the check to run here: the check is a regexp
// scan per term, so a longer text is handed back rather than scanned (Node scans it).
const MaxQueryBytes = 4096

// ShareInterval is READ_SHARE_MS: how long one read of the rows is reused, as Node shares one.
const ShareInterval = 5 * time.Second

// ReadTimeout bounds one cache read.
const ReadTimeout = 250 * time.Millisecond

// Checker is profaneSearchCheck. Safe for concurrent use.
type Checker struct {
	Data   *Data
	Redis  Getter
	Prefix string // the cache key namespace (CACHE_KEY_NAMESPACE + ":", empty in production)
	Flag   Flag
	Now    func() time.Time
	// Verdicts is NewMetrics' counter (nil: not counted).
	Verdicts *prometheus.CounterVec

	mu     sync.Mutex
	shared map[bool]sharedRead // by flag state
	built  map[[32]byte]builtFilter
}

type sharedRead struct {
	at     time.Time
	filter *Filter
	reason string
}

type builtFilter struct {
	filter *Filter
	err    error
}

// Check is profaneSearchCheck(queries): clean when no query has text once trimmed; profane when any
// query's text is; Unproven when that is not proven.
func (c *Checker) Check(ctx context.Context, queries []string) Result {
	var texts []string
	for _, q := range queries {
		if !isASCII(q) {
			return Result{Unproven, ReasonText}
		}
		if jsTrim(q) == "" {
			continue
		}
		if len(q) > MaxQueryBytes {
			return Result{Unproven, ReasonTextLength}
		}
		texts = append(texts, q)
	}
	if len(texts) == 0 {
		return Result{Verdict: Clean}
	}
	if c == nil || c.Data == nil || c.Redis == nil || c.Flag == nil {
		return Result{Unproven, ReasonUnconfigured}
	}
	f, reason := c.filter(ctx)
	if f == nil {
		return Result{Unproven, reason}
	}
	for _, t := range texts {
		bad, err := f.Profane(t)
		if err != nil {
			return Result{Unproven, ReasonText}
		}
		if bad {
			return Result{Verdict: Profane}
		}
	}
	return Result{Verdict: Clean}
}

func (c *Checker) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// filter is the filter Node enforces now, or why that is not known.
func (c *Checker) filter(ctx context.Context) (*Filter, string) {
	var on bool
	switch {
	case c.Flag.On():
		on = true
	case c.Flag.Off():
	default:
		return nil, ReasonFlag
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if s, ok := c.shared[on]; ok && now.Sub(s.at) < ShareInterval && !now.Before(s.at) {
		return s.filter, s.reason
	}
	f, reason := c.read(ctx, on)
	if c.shared == nil {
		c.shared = map[bool]sharedRead{}
	}
	c.shared[on] = sharedRead{at: now, filter: f, reason: reason}
	return f, reason
}

// read is one read of the rows the flag state names, and the filter they build.
func (c *Checker) read(ctx context.Context, on bool) (*Filter, string) {
	benign, err := c.row(ctx, TypeBenign)
	if err != nil {
		return nil, reasonOf(err)
	}
	var blocked []string // nil: the shipped list
	if on {
		row, err := c.row(ctx, TypeBlocked)
		if err != nil {
			return nil, reasonOf(err)
		}
		var entries []string
		if row != nil {
			entries = row
		}
		for _, e := range entries {
			if !isASCII(e) {
				return nil, ReasonListBuild
			}
		}
		if usable, enforced := c.Data.rules.managed(entries); enforced {
			blocked = usable
		}
	}
	f, err := c.build(blocked, benign)
	if err != nil {
		return nil, ReasonListBuild
	}
	return f, ""
}

// build reuses the filter one pair of lists built: a read every ShareInterval rebuilds nothing until
// a list changes.
func (c *Checker) build(blocked, allowed []string) (*Filter, error) {
	h := sha256.New()
	for _, list := range [][]string{blocked, allowed} {
		if list == nil {
			h.Write([]byte{0})
			continue
		}
		h.Write([]byte{1})
		for _, e := range list {
			h.Write([]byte(e))
			h.Write([]byte{0xff}) // never in a string json decoded from valid UTF-8
		}
		h.Write([]byte{0xfe})
	}
	var key [32]byte
	copy(key[:], h.Sum(nil))
	if b, ok := c.built[key]; ok {
		return b.filter, b.err
	}
	f, err := Build(c.Data, blocked, allowed)
	if c.built == nil || len(c.built) >= 4 {
		c.built = map[[32]byte]builtFilter{}
	}
	c.built[key] = builtFilter{f, err}
	return f, err
}

var (
	errMiss  = errors.New("list miss")
	errRead  = errors.New("list read")
	errShape = errors.New("list shape")
)

func reasonOf(err error) string {
	switch {
	case errors.Is(err, errMiss):
		return ReasonListMiss
	case errors.Is(err, errShape):
		return ReasonListShape
	}
	return ReasonListRead
}

// row is readBlocklistWithSource(type).dto as the list service reads it: `data` when the DTO has an
// `id` (a moderator row), nil when it has none (no row: the shipped list for that slot).
func (c *Checker) row(ctx context.Context, typ string) ([]string, error) {
	rctx, cancel := context.WithTimeout(ctx, ReadTimeout)
	defer cancel()
	raw, err := c.Redis.Get(rctx, c.Prefix+KeyPrefix+typ).Result()
	if errors.Is(err, redis.Nil) || (err == nil && raw == "") {
		// An empty value is falsy to Node's `if (cached)`: it reads the database too.
		return nil, errMiss
	}
	if err != nil {
		return nil, errRead
	}
	return parseRow(raw)
}

// parseRow reads a cached BlocklistDTO: `{ id?, type, data }`, `data ?? []`. Anything Node would read
// differently from a plain object of strings (not an object, `data` not an array of strings) is
// errShape.
func parseRow(raw string) ([]string, error) {
	dec := json.NewDecoder(strings.NewReader(raw))
	var obj map[string]json.RawMessage
	if err := dec.Decode(&obj); err != nil || obj == nil {
		return nil, errShape
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errShape // trailing data
	}
	// A repeated key: JSON.parse and Go's map decode both keep the last value.
	id, hasID := obj["id"]
	present := hasID && !bytes.Equal(bytes.TrimSpace(id), []byte("null"))
	data := []string{}
	if d, ok := obj["data"]; ok && !bytes.Equal(bytes.TrimSpace(d), []byte("null")) {
		var raws []json.RawMessage
		if err := json.Unmarshal(d, &raws); err != nil {
			return nil, errShape
		}
		for _, r := range raws {
			var s string
			if t := bytes.TrimSpace(r); len(t) == 0 || t[0] != '"' {
				return nil, errShape
			}
			if err := json.Unmarshal(r, &s); err != nil {
				return nil, errShape
			}
			data = append(data, s)
		}
	}
	if !present {
		return nil, nil
	}
	return data, nil
}
