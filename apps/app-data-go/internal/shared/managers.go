package shared

import (
	"context"
	"errors"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/token"
)

// The `reason` a level stream closes for when its service token could not be minted
// (metrics.CloseReasons).
const (
	CloseServiceTokenRefused     = "service_token_refused"
	CloseServiceTokenUnavailable = "service_token_unavailable"
	// CloseServiceClientUnconfigured: no service client (Reader.Read refuses first; never expected).
	CloseServiceClientUnconfigured = "service_client_unconfigured"
)

// ClassifyServiceToken is the level manager's session.Options.ClassifyExchange: a hub refusal of the
// service token (token.ErrRefused) is ErrServiceTokenRefused, and any other failure to mint it
// ErrServiceTokenUnavailable; a cancelled stream is left to the manager.
func ClassifyServiceToken(err error) *session.ExchangeFailure {
	switch {
	case errors.Is(err, context.Canceled):
		return nil
	case errors.Is(err, ErrNoServiceClient):
		return &session.ExchangeFailure{Reason: CloseServiceClientUnconfigured, Err: ErrNoServiceClient}
	case errors.Is(err, token.ErrRefused):
		return &session.ExchangeFailure{Reason: CloseServiceTokenRefused, Err: ErrServiceTokenRefused}
	default:
		return &session.ExchangeFailure{Reason: CloseServiceTokenUnavailable, Err: ErrServiceTokenUnavailable}
	}
}

// Bounds are one manager's stream caps.
type Bounds struct {
	MaxStreams, MaxRecords, MaxBytes int
}

// Build is what NewReader builds the level and per-viewer managers from (cmd/app-data-go sets each
// from config; the seam test builds them through this same function).
type Build struct {
	Sub session.Subscriber
	// Budget is the process's shared stream and byte budget (session.Budget).
	Budget *session.Budget
	// Level and Viewer bound the two managers. A level stream reserves its MaxBytes from Budget, and
	// so does a per-viewer stream: neither applies acks (overlays live in Overlays).
	Level, Viewer Bounds
	// ServiceToken is this service's own token and its expiry (token.Source.TokenExpiring), and
	// ServiceRefused drops it (token.Source.Invalidate): called when the registry refuses it. A nil
	// ServiceToken is no service client: every read is ErrNoServiceClient (THE SERVICE TOKEN).
	ServiceToken   func(ctx context.Context) (string, time.Time, error)
	ServiceRefused func()
	// ViewerExchange trades a viewer's token for one toward the adapter (exchange.Router.Exchange).
	ViewerExchange func(ctx context.Context, subject string) (exchange.Token, error)
	// LevelMaxAge closes a level stream this long after it opened (at least IdleTTL).
	LevelMaxAge time.Duration
	// The rest are the private manager's (session.Options).
	IdleTTL, MaxAge, Cooldown, NotPrivateCooldown, ExpiryMargin, Recheck, OverlayTTL, ReopenEvery time.Duration
	MaxStreamsPerToken                                                                            int
	Opened                                                                                        func()
	Closed                                                                                        func(reason string)
	// Overlays bound the acknowledged shared writes; ProbesPerApp the signed-out probes per slug.
	MaxOverlays, MaxOverlayBytes, ProbesPerApp int
	// ForwardRegion sends each viewer's region on their per-viewer stream (session.Options.Region);
	// the level streams never carry one.
	ForwardRegion bool
}

// NewReader builds the level and per-viewer managers and the Reader over them. The caller runs and
// closes the two managers.
func NewReader(b Build) (r *Reader, levels, viewers *session.Manager) {
	levelAge := max(b.LevelMaxAge, b.IdleTTL)
	levels = session.New(b.Sub, session.Options{
		MaxStreams: b.Level.MaxStreams, MaxPerToken: 1,
		IdleTTL: b.IdleTTL, MaxAge: levelAge,
		MaxRecords: b.Level.MaxRecords, MaxBytes: b.Level.MaxBytes,
		Budget: b.Budget, Reserve: b.Level.MaxBytes,
		Cooldown: b.Cooldown, NotPrivateCooldown: b.Cooldown,
		Exchange: func(ctx context.Context, _ string) (exchange.Token, error) {
			if b.ServiceToken == nil {
				return exchange.Token{}, ErrNoServiceClient
			}
			// A stream closes ExpiryMargin before the token's expiry, so it never outlives it.
			tok, expires, err := b.ServiceToken(ctx)
			return exchange.Token{Access: tok, Expires: expires}, err
		},
		ClassifyExchange: ClassifyServiceToken,
		InvalidToken:     b.ServiceRefused,
		ExpiryMargin:     b.ExpiryMargin, Opened: b.Opened, Closed: b.Closed,
		OverlayTTL: b.OverlayTTL, ReopenEvery: b.ReopenEvery,
		Accept: AcceptLevel, SubscribeMeta: LevelMeta,
	})
	// The per-viewer streams: as the private ones, under each viewer's exchanged token.
	viewers = session.New(b.Sub, session.Options{
		MaxStreams: b.Viewer.MaxStreams, MaxPerToken: b.MaxStreamsPerToken,
		IdleTTL: b.IdleTTL, MaxAge: b.MaxAge,
		MaxRecords: b.Viewer.MaxRecords, MaxBytes: b.Viewer.MaxBytes,
		Budget: b.Budget, Reserve: b.Viewer.MaxBytes,
		Cooldown: b.Cooldown, NotPrivateCooldown: b.NotPrivateCooldown,
		Exchange: b.ViewerExchange, ExpiryMargin: b.ExpiryMargin, Recheck: b.Recheck,
		Opened: b.Opened, Closed: b.Closed,
		OverlayTTL: b.OverlayTTL, ReopenEvery: b.ReopenEvery,
		Accept: AcceptViewer,
		// The adapter judges the viewer's region on this stream, and names the mask it holds them to.
		Region: b.ForwardRegion,
	})
	r = &Reader{Levels: levels, Viewers: viewers,
		Overlays: &Overlays{TTL: b.OverlayTTL, Max: b.MaxOverlays, MaxBytes: b.MaxOverlayBytes},
		// A schema stays Known while any of its level streams can be open.
		KnownTTL: levelAge, ProbesPerApp: b.ProbesPerApp, NoServiceClient: b.ServiceToken == nil}
	return r, levels, viewers
}

// Acker applies an acknowledged write (session.Manager.Ack).
type Acker interface {
	Ack(token, schema string, a session.Ack)
}

// AckBoth acknowledges a write to the token's private stream (a no-op unless one is open), and to
// the shared overlays only for a schema r Knows: one of its level streams reached Live within a level
// stream's lifetime, so it is a shared collection major whose streams may be open and behind the
// write. Any other schema needs no shared overlay: a shared read of it opens fresh streams, whose
// snapshot already holds the write. So private writes stay out of the shared overlays.
func AckBoth(private Acker, r *Reader) func(token, schema string, a session.Ack) {
	return func(token, schema string, a session.Ack) {
		private.Ack(token, schema, a)
		if r.Known(schema) {
			r.Overlays.Ack(token, schema, a)
		}
	}
}
