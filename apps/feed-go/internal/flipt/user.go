package flipt

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// TargetUser is the session user as Node's buildFliptContext reads it (packages/civitai-flipt/src/
// context.ts, extended by src/server/services/feature-flags.service.ts with isInCreatorProgram).
type TargetUser struct {
	ID          int
	IsModerator bool
	// Tier is the session's `tier`; nil when absent (Node's `user.tier ?? 'free'`).
	Tier               *string
	IsEarlyAdopter     bool
	AppBuilderApproved bool
	// InCreatorProgram is the CreatorProgram bit of the session's `onboarding`.
	InCreatorProgram bool
}

// UserContext is buildFliptContext(user) as the Node app builds it for a signed-in user: every value
// a string, `deploymentId` only when deploymentID (FLIPT_DEPLOYMENT_ID) is set.
func UserContext(u TargetUser, deploymentID string) map[string]string {
	tier := "free"
	if u.Tier != nil {
		tier = *u.Tier
	}
	ctx := map[string]string{
		"userId":             strconv.Itoa(u.ID),
		"isModerator":        strconv.FormatBool(u.IsModerator),
		"tier":               tier,
		"isLoggedIn":         "true",
		"isMember":           strconv.FormatBool(u.Tier != nil && *u.Tier != "" && *u.Tier != "free"),
		"isEarlyAdopter":     strconv.FormatBool(u.IsEarlyAdopter),
		"appBuilderApproved": strconv.FormatBool(u.AppBuilderApproved),
		"isInCreatorProgram": strconv.FormatBool(u.InCreatorProgram),
	}
	if deploymentID != "" {
		ctx["deploymentId"] = deploymentID
	}
	return ctx
}

// ErrBackoff is UserFlag answering without asking Flipt, because a read failed within Backoff.
var ErrBackoff = errors.New("flipt: backing off after a failed read")

// UserFlag answers one boolean flag per entity id and context, as Node's isFlipt(flag, entityId,
// context) does, by asking the Flipt server (Client.BooleanFor) and caching each answer for TTL.
//
// What it does NOT do: hold Flipt's rules. A cache miss is one request to the Flipt server, on the
// caller's request path; an answer it has cached is a map read. The server evaluates with its own
// evaluator, not the engine Node runs: Flipt computes a boolean threshold rollout the same way in
// both (crc32 of entity id + flag key, mod 100) and matches segment constraints on the context, but
// that is not parity-checked here, so the caller must make a disagreement safe in both directions.
//
// Every failure is returned (never cached, never read as off): an unreachable server, a non-200, a
// flag Flipt does not know (ErrFlagNotFound). After one, for Backoff, every uncached read answers
// ErrBackoff without a request, so an outage costs one timeout per Backoff rather than one per call.
// Safe for concurrent use.
type UserFlag struct {
	read func(ctx context.Context, entityID string, evalCtx map[string]string) (bool, error)
	// TTL is how long an answer is reused (0: DefaultUserTTL). A flip reaches a cached viewer within it.
	TTL time.Duration
	// Backoff is how long a failed read stops further reads (0: DefaultUserBackoff).
	Backoff time.Duration
	// MaxEntries bounds the cache (0: DefaultUserMaxEntries). When it is full, expired entries are
	// dropped, and if none were, every entry.
	MaxEntries int
	// Now is the clock (nil: time.Now).
	Now func() time.Time

	mu       sync.Mutex
	entries  map[string]userEntry
	failedAt time.Time // zero: no failure within Backoff
}

type userEntry struct {
	on      bool
	expires time.Time
}

const (
	// DefaultUserTTL is UserFlag's default TTL.
	DefaultUserTTL = 30 * time.Second
	// DefaultUserBackoff is UserFlag's default Backoff.
	DefaultUserBackoff = 5 * time.Second
	// DefaultUserMaxEntries is UserFlag's default MaxEntries (Node's eval cache holds 10 000).
	DefaultUserMaxEntries = 10_000
)

// NewUserFlag is a UserFlag over c for flag.
func NewUserFlag(c *Client, flag string) *UserFlag {
	return NewUserFlagFunc(func(ctx context.Context, entityID string, evalCtx map[string]string) (bool, error) {
		return c.BooleanFor(ctx, flag, entityID, evalCtx)
	})
}

// NewUserFlagFunc is a UserFlag over read (tests).
func NewUserFlagFunc(read func(ctx context.Context, entityID string, evalCtx map[string]string) (bool, error)) *UserFlag {
	return &UserFlag{read: read}
}

// Enabled is the flag for entityID with evalCtx: a cached answer younger than TTL, else a read.
func (f *UserFlag) Enabled(ctx context.Context, entityID string, evalCtx map[string]string) (bool, error) {
	key := cacheKey(entityID, evalCtx)
	now := f.now()
	f.mu.Lock()
	if e, ok := f.entries[key]; ok && now.Before(e.expires) {
		f.mu.Unlock()
		return e.on, nil
	}
	if !f.failedAt.IsZero() && now.Sub(f.failedAt) < f.backoff() {
		f.mu.Unlock()
		return false, ErrBackoff
	}
	f.mu.Unlock()

	on, err := f.read(ctx, entityID, evalCtx)
	now = f.now()
	f.mu.Lock()
	defer f.mu.Unlock()
	if err != nil {
		f.failedAt = now
		return false, err
	}
	f.failedAt = time.Time{}
	if f.entries == nil {
		f.entries = map[string]userEntry{}
	}
	if len(f.entries) >= f.maxEntries() {
		for k, e := range f.entries {
			if !now.Before(e.expires) {
				delete(f.entries, k)
			}
		}
		if len(f.entries) >= f.maxEntries() {
			clear(f.entries)
		}
	}
	f.entries[key] = userEntry{on: on, expires: now.Add(f.ttl())}
	return on, nil
}

// cacheKey is the entity id and the context's pairs in key order: one viewer whose targeting
// properties change (a tier, a moderator grant) is a new key, as Node's eval cache keys it.
func cacheKey(entityID string, evalCtx map[string]string) string {
	keys := make([]string, 0, len(evalCtx))
	for k := range evalCtx {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(entityID)
	for _, k := range keys {
		b.WriteByte(0)
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(evalCtx[k])
	}
	return b.String()
}

func (f *UserFlag) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

func (f *UserFlag) ttl() time.Duration {
	if f.TTL > 0 {
		return f.TTL
	}
	return DefaultUserTTL
}

func (f *UserFlag) backoff() time.Duration {
	if f.Backoff > 0 {
		return f.Backoff
	}
	return DefaultUserBackoff
}

func (f *UserFlag) maxEntries() int {
	if f.MaxEntries > 0 {
		return f.MaxEntries
	}
	return DefaultUserMaxEntries
}
