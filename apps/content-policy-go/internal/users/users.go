// Package users reads the part of a user's row a decision needs, and keeps each answer for a short
// time in process.
//
// The read is the session's own source: the auth service builds a session user from "User"."showNsfw",
// "browsingLevel" and "isModerator" unchanged (apps/auth session-shape.ts), and the site and the
// registry adapter decide from that session user. A user that is deleted or banned is not usable: the
// site refuses a banned user's bearer token (getBearerTokenUser), so no caller decides for one, and
// this service answers it as anonymous.
package users

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/civitai/civitai/apps/content-policy-go/internal/policy"
)

// Query is the one read. It runs on the read replica (DESIGN.md "Database").
const Query = `SELECT "showNsfw", "browsingLevel", COALESCE("isModerator", false) FROM "User" ` +
	`WHERE id = $1 AND "deletedAt" IS NULL AND "bannedAt" IS NULL`

// Source answers a user's settings: found false for a user that does not exist or is not usable.
type Source interface {
	Lookup(ctx context.Context, id int64) (u policy.User, found bool, err error)
}

// Querier is the part of a pgx pool Postgres uses.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Postgres reads users from the database.
type Postgres struct{ DB Querier }

// Lookup implements Source.
func (p Postgres) Lookup(ctx context.Context, id int64) (policy.User, bool, error) {
	var u policy.User
	err := p.DB.QueryRow(ctx, Query, id).Scan(&u.ShowNsfw, &u.BrowsingLevel, &u.IsModerator)
	if errors.Is(err, pgx.ErrNoRows) {
		return policy.User{}, false, nil
	}
	if err != nil {
		return policy.User{}, false, err
	}
	return u, true, nil
}

// Cache keeps each Source answer, found or not, for TTL. An error is never kept: the next request
// asks again. When MaxEntries are held, expired entries are dropped; if none is expired, the new
// answer is not kept (the cache never grows past MaxEntries). TTL <= 0 keeps nothing.
//
// Staleness: a user who changes their settings is answered the old ones for up to TTL (default 30s),
// on top of the read replica's lag. The registry adapter itself notices a settings change only at a
// stream's next token re-check (TOKEN_RECHECK_MS, five minutes), so a shadow comparison can disagree
// for that long after a change, on either side.
type Cache struct {
	Source     Source
	TTL        time.Duration
	MaxEntries int
	Now        func() time.Time

	mu      sync.Mutex
	entries map[int64]entry
}

type entry struct {
	user    policy.User
	found   bool
	expires time.Time
}

// Lookup is Source.Lookup through the cache; hit reports whether the answer came from it.
func (c *Cache) Lookup(ctx context.Context, id int64) (u policy.User, found, hit bool, err error) {
	now := c.now()
	if c.TTL > 0 {
		c.mu.Lock()
		e, ok := c.entries[id]
		c.mu.Unlock()
		if ok && now.Before(e.expires) {
			return e.user, e.found, true, nil
		}
	}
	u, found, err = c.Source.Lookup(ctx, id)
	if err != nil || c.TTL <= 0 {
		return u, found, false, err
	}
	c.put(id, entry{user: u, found: found, expires: now.Add(c.TTL)}, now)
	return u, found, false, nil
}

func (c *Cache) put(id int64, e entry, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[int64]entry{}
	}
	if _, ok := c.entries[id]; !ok && c.MaxEntries > 0 && len(c.entries) >= c.MaxEntries {
		for k, old := range c.entries {
			if !now.Before(old.expires) {
				delete(c.entries, k)
			}
		}
		if len(c.entries) >= c.MaxEntries {
			return
		}
	}
	c.entries[id] = e
}

// Len is the number of answers held, expired ones included until they are swept.
func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

func (c *Cache) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}
