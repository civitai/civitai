// Package index follows the app entity stream on a registry and keeps the store in step with it,
// as the registry spec's model-index example does for models (civitai-registry
// docs/examples/indexes/model-index.md, "Following the stream" and "Starting and rebuilding"):
//
//   - Upsert replaces the app's row, Delete removes it, Progress only moves the cursor, and each
//     stores its cursor in the same transaction (store.Store.Apply).
//   - Live stores its cursor; the first Live of a building generation makes it the serving one,
//     which is when the index starts answering searches (store.Store.Live). Nothing serves before.
//   - End is logged, and the subscription is opened again later, with the longest backoff.
//   - A restart resumes from the stored cursor; a stored empty cursor starts over, since an
//     earlier one would miss deletes ("Consumers" rule 1).
//   - cursor_expired, a LayoutVersion bump, or a serving generation whose cursor is empty starts a
//     new building generation from an empty cursor while the serving one keeps answering; the
//     switch happens at the new one's Live.
//   - Any other end of the stream (a dropped connection, `unavailable`, `slow_consumer`, an error
//     this consumer does not know) reconnects with the same cursor after a bounded exponential
//     backoff with jitter. Every reconnect waits; there is no tight loop.
//   - With a token source (Consumer.Tokens: the index's own client-credentials token), every
//     subscription carries its token. `invalid_token` drops the token and reconnects from the
//     stored cursor, never an empty one, with a new token after the ordinary backoff, which grows
//     while the registry keeps refusing. A token that cannot be fetched is retried the same way,
//     without opening a subscription. Without one, the static token (or none) is sent and
//     `invalid_token` waits the longest backoff, as before.
//   - An upsert whose body is unusable is treated as deleted. An event that cannot be decoded at all
//     (no usable urn, unreadable data) is skipped and counted, advancing the cursor only when it
//     carried one, so one bad event never wedges the stream.
//   - With Consumer.Count set (the listings read model), a snapshot that reaches Live holding no
//     entity is suspect: it is never promoted. The serving generation keeps every row it holds, the
//     hold is logged and counted, and the snapshot is taken again from an empty cursor after the
//     longest backoff. Without it (the app index), an empty snapshot is promoted, as before.
//
// One process may run several consumers, one per stream, each over its own store, generations,
// cursor and consumer lock: the app index always, the listings read model with APP_INDEX_LISTINGS.
package index

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/civitai/civitai/apps/app-index-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-index-go/internal/registry"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// LayoutVersion is the shape of an index row. Bump it when what a row holds changes (a new filter
// column, a changed tsvector): the next start builds a new generation beside the serving one.
// 2: the listing's own rating (listing_rating, listing_rated), which search filters on
// (store.App.GateRating); a layout 1 row was written without reading it from its body.
const LayoutVersion = 2

// ListingsLayoutVersion is LayoutVersion for the listings read model's rows (store.Listing).
// 2: the listing's own rating (listing_content_rating), which the read API gates on. 3: the listing
// id (listing_id), the store's tie-break, required in every body. 4: the listing's sub-listings
// (sub_listing_keys, and subListings required in every body). A generation of another layout is
// not served by the listing API (api.Server.ListingsLayout).
const ListingsLayoutVersion = 4

// Events is one open subscription.
type Events interface {
	Next() (registry.Event, error)
	Close() error
}

// Subscriber opens subscriptions.
type Subscriber interface {
	Subscribe(ctx context.Context, req registry.Request) (Events, error)
}

// TokenSource hands out the bearer token of each subscription (token.Source).
type TokenSource interface {
	// Token is a token to subscribe with.
	Token(ctx context.Context) (string, error)
	// Invalidate drops the current token: the registry refused it.
	Invalidate()
}

// ClientSubscriber is a Subscriber over the HTTP binding.
type ClientSubscriber struct{ Client *registry.Client }

// Subscribe implements Subscriber.
func (c ClientSubscriber) Subscribe(ctx context.Context, req registry.Request) (Events, error) {
	s, err := c.Client.Subscribe(ctx, req)
	if err != nil {
		return nil, err
	}
	return s, nil
}

// Backoff is a bounded exponential backoff with jitter: attempt n waits a random duration in
// [d/2, d), d = min(Base * 2^n, Max). Never zero, so a failing registry is never polled in a loop.
type Backoff struct {
	Base, Max time.Duration
	// Jitter returns a value in [0, 1); nil is math/rand.
	Jitter func() float64
}

// Delay is how long attempt n (from 0) waits.
func (b Backoff) Delay(attempt int) time.Duration {
	d := b.Base
	for i := 0; i < attempt && d < b.Max; i++ {
		d *= 2
	}
	d = min(d, b.Max)
	j := b.Jitter
	if j == nil {
		j = rand.Float64
	}
	return d/2 + time.Duration(j()*float64(d/2))
}

// Consumer follows one schema's stream into a store.
type Consumer struct {
	Store   store.Generations
	Sub     Subscriber
	Schema  string
	Layout  int
	Log     *slog.Logger
	Metrics *metrics.Stream
	Backoff Backoff
	// Decode turns an upsert's entity into its change, or says why the body is unusable (the
	// entity is then treated as deleted). Nil is the app entity's (store.DecodeApp).
	Decode func(urn, rev string, body json.RawMessage) (store.Change, error)
	// Count, when set, is how many rows a generation holds, and switches on the empty-snapshot
	// hold: a building generation that reaches Live with none is never promoted (package doc).
	// Metrics.EmptySnapshots must be set with it.
	Count func(ctx context.Context, gen int64) (int, error)
	// Sleep waits d or until ctx ends; nil is a timer. Tests replace it to observe the delays.
	Sleep func(ctx context.Context, d time.Duration) error
	// Tokens, when set, supplies every subscription's bearer token, and is told when the registry
	// refuses one. Nil: the registry.Client's own token (or none) is sent, unchanged.
	Tokens TokenSource
}

// maxAttempt caps the backoff exponent (the delay is capped at Backoff.Max long before).
const maxAttempt = 30

var errEnded = errors.New("registry ended the stream")

// errEmptySnapshot ends a subscription whose snapshot reached Live with no entity (Consumer.Count).
var errEmptySnapshot = errors.New("snapshot ended with no entity")

// storeError marks a failure of the store, as opposed to the stream.
type storeError struct{ err error }

func (e storeError) Error() string { return "store: " + e.err.Error() }
func (e storeError) Unwrap() error { return e.err }

// tokenError marks a failure to get a token: no subscription was opened.
type tokenError struct{ err error }

func (e tokenError) Error() string { return "token: " + e.err.Error() }
func (e tokenError) Unwrap() error { return e.err }

// Run follows the stream until ctx ends.
func (c *Consumer) Run(ctx context.Context) error {
	attempt := 0
	var unlock func()
	defer func() {
		if unlock != nil {
			unlock()
		}
	}()
	for ctx.Err() == nil {
		if unlock == nil {
			u, err := c.Store.Lock(ctx)
			if err != nil {
				if errors.Is(err, store.ErrLocked) {
					c.Log.Info("another consumer holds the lock; serving searches only until it is free")
				} else if ctx.Err() == nil {
					c.Log.Warn("consumer lock", "err", err)
				}
				c.wait(ctx, c.Backoff.Delay(attempt))
				attempt = min(attempt+1, maxAttempt)
				continue
			}
			unlock = u
		}
		gen, err := c.prepare(ctx)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			c.Log.Warn("prepare generation", "err", err)
			c.Metrics.Reconnects.WithLabelValues("store").Inc()
			c.wait(ctx, c.Backoff.Delay(attempt))
			attempt = min(attempt+1, maxAttempt)
			continue
		}
		live, err := c.follow(ctx, &gen)
		if ctx.Err() != nil {
			break
		}
		if live {
			// The stream worked: the next failure starts the backoff over (still never zero).
			attempt = 0
		}
		reason, longWait := c.handle(ctx, gen, err)
		if errors.Is(err, store.ErrFenced) {
			unlock()
			unlock = nil
		}
		c.Metrics.Reconnects.WithLabelValues(reason).Inc()
		d := c.Backoff.Delay(attempt)
		if longWait {
			d = c.Backoff.Delay(maxAttempt)
		}
		c.wait(ctx, d)
		attempt = min(attempt+1, maxAttempt)
	}
	return nil
}

func (c *Consumer) wait(ctx context.Context, d time.Duration) {
	if c.Sleep != nil {
		_ = c.Sleep(ctx, d)
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// handle decides what an ended stream means: the reconnect reason, and whether to wait the
// longest backoff (End, bad_request, auth: retrying sooner would not change the answer).
func (c *Consumer) handle(ctx context.Context, gen store.Generation, err error) (reason string, longWait bool) {
	var se storeError
	var te tokenError
	switch {
	case errors.Is(err, errEnded):
		c.Log.Warn("registry sent End; subscribing again later", "generation", gen.ID)
		return "end", true
	case errors.Is(err, errEmptySnapshot):
		// Logged where it was found; a catalog that legitimately empties is rare, and retrying
		// sooner would most likely get the same answer.
		return "empty_snapshot", true
	case errors.As(err, &se):
		c.Log.Warn("store write failed; reconnecting from the stored cursor", "err", se.err, "generation", gen.ID)
		return "store", false
	case errors.As(err, &te):
		c.Log.Warn("no token; retrying from the stored cursor", "err", te.err, "generation", gen.ID)
		return "token", false
	}
	code := registry.CodeOf(err)
	switch code {
	case registry.CursorExpired:
		c.Log.Warn("cursor expired; rebuilding from an empty cursor", "generation", gen.ID, "state", gen.State)
		if gen.State == store.StateServing {
			if _, err := c.Store.NewBuilding(ctx, c.Schema, c.Layout); err != nil {
				c.Log.Warn("start rebuild", "err", err)
				return "store", false
			}
		} else if err := c.Store.Reset(ctx, gen.ID); err != nil {
			c.Log.Warn("reset building generation", "err", err)
			return "store", false
		}
		c.Metrics.Rebuilds.WithLabelValues("cursor_expired").Inc()
		return "cursor_expired", false
	case registry.SlowConsumer:
		c.Log.Info("registry ended the stream for a slow consumer; reconnecting", "generation", gen.ID)
		return "slow_consumer", false
	case registry.BadRequest:
		c.Log.Error("registry refused the request", "err", err)
		return "bad_request", true
	case registry.InvalidToken, registry.InsufficientScope:
		if code == registry.InvalidToken && c.Tokens != nil {
			// The token expired or was revoked: a new one may be accepted. The stored cursor is
			// kept; the next subscription resumes from it.
			c.Tokens.Invalidate()
			c.Log.Warn("registry refused the token; resuming from the stored cursor with a new one", "generation", gen.ID)
			return "auth", false
		}
		c.Log.Error("registry refused the token", "code", string(code))
		return "auth", true
	default:
		c.Log.Info("stream ended; reconnecting", "err", err, "generation", gen.ID)
		return "unavailable", false
	}
}

// prepare picks the generation to follow and claims it, starting one where it must.
func (c *Consumer) prepare(ctx context.Context) (store.Generation, error) {
	st, err := c.Store.State(ctx)
	if err != nil {
		return store.Generation{}, err
	}
	c.setServing(st.Serving)
	fresh := func(reason string) (store.Generation, error) {
		g, err := c.Store.NewBuilding(ctx, c.Schema, c.Layout)
		if err != nil {
			return store.Generation{}, err
		}
		c.Metrics.Rebuilds.WithLabelValues(reason).Inc()
		c.Log.Info("building a new generation", "generation", g.ID, "reason", reason)
		return g, nil
	}
	if b := st.Building; b != nil {
		if b.Layout != c.Layout || b.Schema != c.Schema {
			return fresh("layout")
		}
		if err := c.Store.Claim(ctx, b.ID); err != nil {
			return store.Generation{}, err
		}
		if b.Cursor == "" {
			// An empty cursor cannot be resumed: the snapshot starts over (crash mid-snapshot).
			if err := c.Store.Reset(ctx, b.ID); err != nil {
				return store.Generation{}, err
			}
		}
		return *b, nil
	}
	if s := st.Serving; s != nil {
		if s.Layout != c.Layout || s.Schema != c.Schema {
			return fresh("layout")
		}
		if s.Cursor == "" {
			return fresh("empty_cursor")
		}
		if err := c.Store.Claim(ctx, s.ID); err != nil {
			return store.Generation{}, err
		}
		return *s, nil
	}
	return fresh("first_start")
}

func (c *Consumer) setServing(g *store.Generation) {
	if g == nil {
		c.Metrics.Ready.Set(0)
		c.Metrics.Generation.Set(0)
		return
	}
	c.Metrics.Ready.Set(1)
	c.Metrics.Generation.Set(float64(g.ID))
}

// follow subscribes from gen's cursor and applies events until the stream ends. live reports
// whether it reached Live, i.e. the subscription worked.
func (c *Consumer) follow(ctx context.Context, gen *store.Generation) (live bool, err error) {
	req := registry.Request{Schema: c.Schema, Cursor: gen.Cursor}
	if c.Tokens != nil {
		tok, err := c.Tokens.Token(ctx)
		if err != nil {
			return false, tokenError{err}
		}
		req.Token = tok
	}
	events, err := c.Sub.Subscribe(ctx, req)
	if err != nil {
		return false, err
	}
	defer func() { _ = events.Close() }()
	for {
		ev, err := events.Next()
		if err != nil {
			return live, err
		}
		typ := string(ev.Type)
		switch ev.Type {
		case registry.Upsert:
			decode := c.Decode
			if decode == nil {
				decode = store.DecodeApp
			}
			ch, verr := decode(ev.Entity.URN, ev.Entity.Rev, ev.Entity.Body)
			if verr != nil {
				// A body this index cannot use is treated as deleted (spec "Validity" rule 2).
				c.Log.Warn("unusable body; treating it as deleted", "schema", c.Schema, "urn", ev.Entity.URN, "reason", verr.Error())
				ch = store.Change{Kind: store.ChangeDelete, URN: ev.Entity.URN}
				typ = "invalid"
			}
			ch.Cursor = ev.Cursor
			for _, d := range ch.Dropped {
				c.Log.Warn("part of a body left out; entity kept", "schema", c.Schema, "urn", ev.Entity.URN,
					"what", d.What, "reason", d.Reason)
				if c.Metrics.Dropped != nil {
					c.Metrics.Dropped.WithLabelValues(d.What).Inc()
				}
			}
			if err := c.Store.Apply(ctx, gen.ID, ch); err != nil {
				return live, storeError{err}
			}
		case registry.Delete:
			if err := c.Store.Apply(ctx, gen.ID, store.Change{Kind: store.ChangeDelete, URN: ev.URN, Cursor: ev.Cursor}); err != nil {
				return live, storeError{err}
			}
		case registry.Progress:
			if err := c.Store.Apply(ctx, gen.ID, store.Change{Kind: store.ChangeProgress, Cursor: ev.Cursor}); err != nil {
				return live, storeError{err}
			}
		case registry.Live:
			if gen.State == store.StateBuilding && c.Count != nil {
				if err := c.holdEmpty(ctx, gen); err != nil {
					return live, err
				}
			}
			promoted, err := c.Store.Live(ctx, gen.ID, ev.Cursor)
			if err != nil {
				return live, storeError{err}
			}
			gen.Cursor = ev.Cursor
			if promoted {
				gen.State = store.StateServing
				c.setServing(gen)
				c.Log.Info("generation is serving", "generation", gen.ID)
			}
			live = true
		case registry.Malformed:
			// Skipped, never the end of the stream: reconnecting would replay the same event
			// forever. Advanced past only when it carried a cursor, as a Progress would be.
			c.Metrics.Malformed.WithLabelValues(string(ev.Of)).Inc()
			c.Log.Warn("malformed registry event skipped", "type", string(ev.Of), "reason", ev.Reason,
				"advanced", ev.Cursor != "", "generation", gen.ID)
			if ev.Cursor == "" {
				continue
			}
			if err := c.Store.Apply(ctx, gen.ID, store.Change{Kind: store.ChangeProgress, Cursor: ev.Cursor}); err != nil {
				return live, storeError{err}
			}
			gen.Cursor = ev.Cursor
			continue
		case registry.End:
			c.Metrics.EventApplied(typ)
			return live, errEnded
		}
		gen.Cursor = ev.Cursor
		c.Metrics.EventApplied(typ)
	}
}

// holdEmpty is the empty-snapshot hold, at the Live of a building generation: one holding no row is
// not promoted. Its rows (none) and cursor are reset, so the next subscription takes the snapshot
// again from an empty cursor, and errEmptySnapshot ends this one; the serving generation, if any,
// is untouched and keeps every row it holds. A catalog that empties is far likelier to be a failed
// upstream read than a real one, and switching to it would empty the read model.
func (c *Consumer) holdEmpty(ctx context.Context, gen *store.Generation) error {
	n, err := c.Count(ctx, gen.ID)
	if err != nil {
		return storeError{err}
	}
	if n > 0 {
		return nil
	}
	c.Metrics.EmptySnapshots.Inc()
	c.Log.Warn("snapshot ended with no entity; not switching to it, keeping the serving generation, and taking it again later",
		"schema", c.Schema, "generation", gen.ID)
	if err := c.Store.Reset(ctx, gen.ID); err != nil {
		return storeError{err}
	}
	return errEmptySnapshot
}
