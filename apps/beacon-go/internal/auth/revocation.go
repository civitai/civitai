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

// Revocation reads the registry createRevocationCheck() reads: one pipelined round trip, bounded by
// Timeout. When the read fails it returns the error and decides nothing. The main app does not simply
// allow the request there: it keeps a marker cache that still denies revocations it has already seen,
// which this service does not hold, so the caller hands the request back to the Node app instead of
// guessing.
type Revocation struct {
	Redis   RevocationReader
	Timeout time.Duration
	// OnReadError is called when the read failed (the request then falls back).
	OnReadError func(err error)
}

// IsRevoked reports whether the session has been signed out, banned or cut, or the read's error.
func (r *Revocation) IsRevoked(ctx context.Context, c *Claims) (bool, error) {
	if c.Jti == "" {
		return false, nil
	}
	timeout := r.Timeout
	if timeout == 0 {
		timeout = time.Second // DEFAULT_REVOCATION_READ_TIMEOUT_MS
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	userID := c.UserID()
	family := c.FamilyID()
	var (
		state, familyState, all, userCut, impUserCut, impCut *redis.StringCmd
	)
	_, err := r.Redis.Pipelined(ctx, func(p redis.Pipeliner) error {
		state = p.HGet(ctx, keyTokenState, c.Jti)
		if family != "" {
			familyState = p.HGet(ctx, keyFamilyState, family)
		}
		all = p.Get(ctx, keyAll)
		if userID != 0 {
			userCut = p.Get(ctx, keyUserCut+":"+strconv.Itoa(userID))
		}
		if c.ImpersonatedBy != nil {
			mod := strconv.FormatInt(int64(*c.ImpersonatedBy), 10)
			impUserCut = p.Get(ctx, keyUserCut+":"+mod)
			impCut = p.Get(ctx, keyUserCut+":impersonator:"+mod)
		}
		return nil
	})
	if err != nil && !errors.Is(err, redis.Nil) {
		if r.OnReadError != nil {
			r.OnReadError(err)
		}
		return false, err
	}
	return Decide(c, val(state), val(familyState), val(all), val(userCut), val(impUserCut), val(impCut)), nil
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
