// Package flipt reads one global boolean Flipt flag with the arguments the Node app's cached flag
// gate passes (createCachedFlagGate over isFliptSync, src/server/utils/cached-flag-gate.ts): entity
// id 'global', no context, a value reused for 5 s. What a failure reads as follows Node's whole
// stack, not that gate alone: Node's client keeps its last snapshot when a poll fails, so a Switch
// keeps its last good value through failed reads (Switch.Refresh), up to a staleness bound Node does
// not have; a never-read flag or a key Flipt says does not exist reads OFF, as the gate reads them.
//
// It is the standard library on purpose, not go.flipt.io/flipt-client (the in-process engine the Go
// services are to adopt, packages/civitai-flipt/parity, which brings a wasm runtime with it): this
// service reads one global on/off switch, so it asks the server to evaluate it
// (POST /evaluate/v1/boolean) with the URL, client token and Flipt environment the Node app's client
// uses (FLIPT_URL, FLIPT_FETCHER_SECRET, FLIPT_ENVIRONMENT). The server's evaluator is not the
// engine Node runs, so only a flag's plain on/off is claimed to answer both runtimes alike; a
// percentage rollout or segment rule on a flag read here is not parity-checked. Use it for global
// boolean switches only, and move to the shared client when feed-go adopts it.
//
// The one exception is UserFlag (user.go), a per-viewer boolean read for a fallback decision only:
// it may answer a viewer differently from Node, and the caller must make either answer safe.
package flipt

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultEnvironment is FLIPT_ENVIRONMENT's default, as in packages/civitai-flipt/src/env.ts.
const DefaultEnvironment = "civitai-app"

// GlobalEntityID is the entity id Node's client evaluates a flag with when the caller names none.
const GlobalEntityID = "global"

// RefreshInterval is CACHED_FLAG_GATE_REFRESH_MS: how long one read of a flag is reused. A flip takes
// effect within it.
const RefreshInterval = 5 * time.Second

// ErrFlagNotFound is Flipt answering that the flag does not exist (HTTP 404).
var ErrFlagNotFound = errors.New("flag not found")

// Config is where Flipt is.
type Config struct {
	// URL is FLIPT_URL: the server's base URL.
	URL string
	// ClientToken is FLIPT_FETCHER_SECRET, sent as a bearer token.
	ClientToken string
	// Environment is FLIPT_ENVIRONMENT ("" is DefaultEnvironment).
	Environment string
	// Timeout bounds one evaluation request (0: RefreshInterval, so a hung server never holds more
	// than one read at a time).
	Timeout time.Duration
	// HTTP is the client (nil: a dedicated one).
	HTTP *http.Client
}

// Client evaluates boolean flags. Safe for concurrent use.
type Client struct {
	endpoint string
	token    string
	env      string
	timeout  time.Duration
	http     *http.Client
}

// New validates cfg: the URL must be absolute http(s).
func New(cfg Config) (*Client, error) {
	u, err := url.Parse(cfg.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		// Not wrapped: url.Parse's error repeats the URL.
		return nil, errors.New("flipt url: want an absolute http(s) URL")
	}
	env := cfg.Environment
	if env == "" {
		env = DefaultEnvironment
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = RefreshInterval
	}
	hc := cfg.HTTP
	if hc == nil {
		hc = &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone()}
	}
	return &Client{endpoint: strings.TrimRight(cfg.URL, "/") + "/evaluate/v1/boolean", token: cfg.ClientToken, env: env,
		timeout: timeout, http: hc}, nil
}

type booleanRequest struct {
	NamespaceKey string            `json:"namespaceKey"`
	FlagKey      string            `json:"flagKey"`
	EntityID     string            `json:"entityId"`
	Context      map[string]string `json:"context"`
}

// Boolean evaluates flag for the global entity with no context. Anything but a 200 whose body
// carries a boolean `enabled` is an error; an unknown flag (Flipt answers it 404) is ErrFlagNotFound.
func (c *Client) Boolean(ctx context.Context, flag string) (bool, error) {
	return c.BooleanFor(ctx, flag, GlobalEntityID, nil)
}

// BooleanFor is Boolean for one entity id and context (nil: an empty context), as Node's
// isFlipt(flag, entityId, context) asks. One request per call: UserFlag caches the answers.
func (c *Client) BooleanFor(ctx context.Context, flag, entityID string, evalCtx map[string]string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	if evalCtx == nil {
		evalCtx = map[string]string{}
	}
	body, err := json.Marshal(booleanRequest{NamespaceKey: "default", FlagKey: flag, EntityID: entityID, Context: evalCtx})
	if err != nil {
		return false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Flipt-Environment", c.env)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return false, fmt.Errorf("flipt: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return false, fmt.Errorf("flipt: %s: %w", flag, ErrFlagNotFound)
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return false, fmt.Errorf("flipt: %s: http %d", flag, resp.StatusCode)
	}
	var out struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out); err != nil {
		return false, fmt.Errorf("flipt: %s: %w", flag, err)
	}
	if out.Enabled == nil {
		return false, fmt.Errorf("flipt: %s: no enabled field", flag)
	}
	return *out.Enabled, nil
}

// Switch is one global boolean flag, read in the background so a request never waits on Flipt.
// On is false until the first read succeeds; after that a failed read keeps the last good value for
// up to MaxStale (Refresh says exactly what each outcome does).
type Switch struct {
	read func(ctx context.Context) (bool, error)
	on   atomic.Bool
	// OnError, when set, sees every failed read.
	OnError func(err error)
	// OnStale, when set, is called once each time the last good value is dropped for being older
	// than MaxStale.
	OnStale func(age time.Duration)
	// MaxStale is how long the last good value outlives failed reads (0: DefaultMaxStale).
	MaxStale time.Duration
	// Now is the clock (nil: time.Now).
	Now func() time.Time

	mu     sync.Mutex
	lastOK time.Time // zero: never read successfully
	stale  bool      // OnStale already called for the current outage
}

// DefaultMaxStale is how long a Switch keeps its last good value while every read fails. Past it the
// switch reads OFF: a flag nobody can confirm stops steering traffic.
const DefaultMaxStale = 10 * time.Minute

// NewSwitch is a switch over read (Client.Boolean of one flag, in production).
func NewSwitch(read func(ctx context.Context) (bool, error)) *Switch {
	return &Switch{read: read}
}

// On is the current value (see Refresh).
func (s *Switch) On() bool {
	return s != nil && s.on.Load()
}

// Refresh reads the flag once. A successful read sets the value. Flipt answering that the flag does
// not exist (ErrFlagNotFound) sets it OFF, as Node's evaluation of a key missing from its snapshot
// throws and its gate reads that as off. Any other failure keeps the last good value, as Node's client
// keeps serving its last snapshot when a poll fails (errorStrategy FALLBACK); it reads OFF only when
// no read has ever succeeded, or when the last success is older than MaxStale (OnStale is told once).
func (s *Switch) Refresh(ctx context.Context) {
	on, err := s.read(ctx)
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err == nil || errors.Is(err, ErrFlagNotFound) {
		if err != nil {
			on = false
		}
		s.lastOK, s.stale = now, false
		s.on.Store(on)
		if err != nil && s.OnError != nil {
			s.OnError(err)
		}
		return
	}
	if s.OnError != nil {
		s.OnError(err)
	}
	if s.lastOK.IsZero() {
		s.on.Store(false)
		return
	}
	maxStale := s.MaxStale
	if maxStale <= 0 {
		maxStale = DefaultMaxStale
	}
	if age := now.Sub(s.lastOK); age > maxStale {
		s.on.Store(false)
		if !s.stale {
			s.stale = true
			if s.OnStale != nil {
				s.OnStale(age)
			}
		}
	}
}

func (s *Switch) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Run reads the flag now and then on every tick until ctx ends.
func (s *Switch) Run(ctx context.Context, ticks <-chan time.Time) {
	s.Refresh(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			s.Refresh(ctx)
		}
	}
}

// Start runs the switch every RefreshInterval in its own goroutine until ctx ends.
func (s *Switch) Start(ctx context.Context) {
	t := time.NewTicker(RefreshInterval)
	go func() {
		defer t.Stop()
		s.Run(ctx, t.C)
	}()
}
