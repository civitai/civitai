package auth

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Revocation registry keys: REDIS_SYS_KEYS.SESSION in packages/civitai-redis/src/client.ts, read by
// isRevoked() in packages/civitai-auth/src/session-registry.ts. They live on the SYSTEM redis.
const (
	keyTokenState  = "session:token-state"
	keyFamilyState = "session:family-state"
	keyAll         = "session:all"
	keyUserCut     = "session:user-cut"
)

// RevocationReader is the subset of a redis client the check needs.
type RevocationReader interface {
	Pipelined(ctx context.Context, fn func(redis.Pipeliner) error) ([]redis.Cmder, error)
}

// The verdicts createRevocationCheck() gives when the read failed (RevocationDegradedVerdict).
const (
	// VerdictDenyCached: a revocation marker this process had already read applied; signed out.
	VerdictDenyCached = "deny_cached"
	// VerdictAllowUnknown: no known marker applied (or the record is off); the session was allowed.
	VerdictAllowUnknown = "allow_unknown"
)

// Revocation mirrors createRevocationCheck() (packages/civitai-auth/src/revocation-check.ts): one
// pipelined round trip, bounded by Timeout. When the read fails (an error or the deadline), the verdict
// comes from the markers this process has already read (Markers): a revocation seen here still denies
// (deny_cached), and a session with no known marker is allowed (allow_unknown), so a store outage never
// signs everyone out. A nil Markers is SESSION_REVOCATION_CACHE=off: nothing is recorded and every failed
// read allows, as the package does with `markerCache: false`.
type Revocation struct {
	Redis   RevocationReader
	Timeout time.Duration
	// Markers is the record of markers read (NewMarkerCache); nil turns it off.
	Markers *MarkerCache
	// OnDegraded is called when the read failed, with the verdict then given from the markers.
	OnDegraded func(err error, verdict string)
}

// IsRevoked reports whether the session has been signed out, banned or cut.
func (r *Revocation) IsRevoked(ctx context.Context, c *Claims) bool {
	revoked, _ := r.Check(ctx, c)
	return revoked
}

// Check is IsRevoked that also reports whether the read failed, so the verdict came from the markers.
func (r *Revocation) Check(ctx context.Context, c *Claims) (revoked, readFailed bool) {
	if c.Jti == "" {
		return false, false
	}
	timeout := r.Timeout
	if timeout == 0 {
		timeout = time.Second // DEFAULT_REVOCATION_READ_TIMEOUT_MS
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	k := revocationKeysOf(c)
	var (
		state, familyState, all, userCut, impUserCut, impCut *redis.StringCmd
	)
	_, err := r.Redis.Pipelined(ctx, func(p redis.Pipeliner) error {
		state = p.HGet(ctx, keyTokenState, c.Jti)
		if k.family != "" {
			familyState = p.HGet(ctx, keyFamilyState, k.family)
		}
		all = p.Get(ctx, keyAll)
		if k.userCut != "" {
			userCut = p.Get(ctx, k.userCut)
		}
		if k.impUserCut != "" {
			impUserCut = p.Get(ctx, k.impUserCut)
			impCut = p.Get(ctx, k.impCut)
		}
		return nil
	})
	// Pipelined returns the FIRST command error, and an absent key (redis.Nil) is one, so a command that
	// failed after one that found nothing is only visible on the command itself.
	failed := err != nil && !errors.Is(err, redis.Nil)
	for _, cmd := range []*redis.StringCmd{state, familyState, all, userCut, impUserCut, impCut} {
		if cmd == nil {
			continue
		}
		if e := cmd.Err(); e != nil && !errors.Is(e, redis.Nil) && !failed {
			failed, err = true, e
		}
	}
	if m := r.Markers; m != nil {
		// Every read that came back is recorded, the failed ones are not: in the package each command
		// resolves on its own and is recorded before the batch's failure is seen, so a marker read in the
		// same round trip as a failed command still counts.
		obs := func(cmd *redis.StringCmd) reply { return observed(cmd, failed) }
		m.observeHash(keyTokenState, c.Jti, obs(state))
		if familyState != nil {
			m.observeHash(keyFamilyState, k.family, obs(familyState))
		}
		m.observeKey(keyAll, obs(all))
		if userCut != nil {
			m.observeKey(k.userCut, obs(userCut))
		}
		if impUserCut != nil {
			m.observeKey(k.impUserCut, obs(impUserCut))
			m.observeKey(k.impCut, obs(impCut))
		}
	}
	if failed {
		revoked := r.Markers != nil && r.decideFromMarkers(c, k)
		verdict := VerdictAllowUnknown
		if revoked {
			verdict = VerdictDenyCached
		}
		if r.OnDegraded != nil {
			r.OnDegraded(err, verdict)
		}
		return revoked, true
	}
	return Decide(c, val(state), val(familyState), val(all), val(userCut), val(impUserCut), val(impCut)), false
}

// revocationKeys are the per-claims keys of the read ("" = not read).
type revocationKeys struct {
	family, userCut, impUserCut, impCut string
}

func revocationKeysOf(c *Claims) revocationKeys {
	k := revocationKeys{family: c.FamilyID()}
	if id := c.UserID(); id != 0 {
		k.userCut = keyUserCut + ":" + strconv.Itoa(id)
	}
	if c.ImpersonatedBy != nil {
		mod := strconv.FormatInt(int64(*c.ImpersonatedBy), 10)
		k.impUserCut = keyUserCut + ":" + mod
		k.impCut = keyUserCut + ":impersonator:" + mod
	}
	return k
}

// decideFromMarkers is the package's second registry over reader(): the same Decide, asked of the
// record instead of the store. Absent entries read as "".
func (r *Revocation) decideFromMarkers(c *Claims, k revocationKeys) bool {
	m := r.Markers
	look := func(key string) string {
		if key == "" {
			return ""
		}
		return m.lookup(key)
	}
	familyState := ""
	if k.family != "" {
		familyState = m.lookup(hashEntry(keyFamilyState, k.family))
	}
	return Decide(c, m.lookup(hashEntry(keyTokenState, c.Jti)), familyState, m.lookup(keyAll),
		look(k.userCut), look(k.impUserCut), look(k.impCut))
}

// observed is one command's outcome for the record. In a failed round trip a command can be left with
// no error and no value without ever having been answered (go-redis stamps the batch error only on some
// failures), so there an empty value is not taken as an answer: only an explicit nil reply or a value is.
func observed(cmd *redis.StringCmd, batchFailed bool) reply {
	s, err := cmd.Result()
	switch {
	case err == nil && s == "" && batchFailed:
		return reply{}
	case err == nil:
		return reply{value: s, ok: true, present: true}
	case errors.Is(err, redis.Nil):
		return reply{ok: true}
	default:
		return reply{}
	}
}

func val(cmd *redis.StringCmd) string {
	if cmd == nil {
		return ""
	}
	s, err := cmd.Result()
	if err != nil {
		return ""
	}
	return s
}

// Decide is the pure decision of isRevoked() given the six reads ("" = absent).
func Decide(c *Claims, state, familyState, all, userCut, impUserCut, impCut string) bool {
	if state == "invalid" || familyState == "invalid" {
		return true
	}
	if c.SignedAt == nil || *c.SignedAt == 0 {
		return false
	}
	signedAt := *c.SignedAt
	if all != "" {
		if t, err := parseJSDate(all); err == nil && float64(t.UnixMilli()) > signedAt {
			return true
		}
	}
	for _, cut := range []string{userCut, impUserCut, impCut} {
		if cut == "" {
			continue
		}
		if n, err := strconv.ParseFloat(cut, 64); err == nil && n > signedAt {
			return true
		}
	}
	return false
}

// parseJSDate accepts the ISO strings `new Date().toISOString()` writes (and RFC 3339 generally).
func parseJSDate(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	return time.Parse("2006-01-02T15:04:05.000Z", s)
}
