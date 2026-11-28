// Package flipt reads the one Flipt value beacon-go needs: the `feed-events-sample-rate` variant
// (FEED_EVENTS_SAMPLE_RATE_FLAG, src/server/services/feed-events.service.ts), which decides which
// browser sessions the feed events recorder keeps. Node reads it with getFliptVariantDetailSync(flag)
// for the global entity and no context, and turns it into a rate with parseSampleRate when it
// matched (no match: 0).
//
// It asks the Flipt server to evaluate (POST /evaluate/v1/variant) with the URL, client token and
// environment the Node app's client uses (FLIPT_URL, FLIPT_FETCHER_SECRET, FLIPT_ENVIRONMENT), the
// way apps/feed-go/internal/flipt reads its boolean switches. The server's evaluator is not the
// in-process engine Node runs; for a global entity with no context the two agree on a variant flag
// whose rules match every entity, which is how this dial is used (one variant whose key is the rate).
// A segment rule on it would not be parity-checked here. What a failed read does is Rate's choice:
// this service never guesses a rate, it falls back to Node (beacon.ReasonTrackFeedSampleRate).
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
	"time"
)

// DefaultEnvironment is FLIPT_ENVIRONMENT's default (packages/civitai-flipt/src/env.ts).
const DefaultEnvironment = "civitai-app"

// GlobalEntityID is the entity id Node's client evaluates with when the caller names none.
const GlobalEntityID = "global"

// ErrFlagNotFound is Flipt answering that the flag does not exist (HTTP 404).
var ErrFlagNotFound = errors.New("flag not found")

// Config is where Flipt is.
type Config struct {
	URL         string // FLIPT_URL
	ClientToken string // FLIPT_FETCHER_SECRET, sent as a bearer token
	Environment string // FLIPT_ENVIRONMENT ("" is DefaultEnvironment)
	// Timeout bounds one evaluation (0: 5 s).
	Timeout time.Duration
	HTTP    *http.Client // nil: a dedicated client
}

// Client evaluates variant flags. Safe for concurrent use.
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
		timeout = 5 * time.Second
	}
	hc := cfg.HTTP
	if hc == nil {
		hc = &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone()}
	}
	return &Client{endpoint: strings.TrimRight(cfg.URL, "/") + "/evaluate/v1/variant", token: cfg.ClientToken, env: env, timeout: timeout, http: hc}, nil
}

type variantRequest struct {
	NamespaceKey string            `json:"namespaceKey"`
	FlagKey      string            `json:"flagKey"`
	EntityID     string            `json:"entityId"`
	Context      map[string]string `json:"context"`
}

// Variant evaluates flag for the global entity with no context: whether a rule matched, and the
// variant key it picked. Anything but a 200 whose body carries a boolean `match` is an error; an
// unknown flag is ErrFlagNotFound.
func (c *Client) Variant(ctx context.Context, flag string) (match bool, variantKey string, err error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	body, err := json.Marshal(variantRequest{NamespaceKey: "default", FlagKey: flag, EntityID: GlobalEntityID, Context: map[string]string{}})
	if err != nil {
		return false, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return false, "", err
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
		return false, "", fmt.Errorf("flipt: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return false, "", fmt.Errorf("flipt: %s: %w", flag, ErrFlagNotFound)
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return false, "", fmt.Errorf("flipt: %s: http %d", flag, resp.StatusCode)
	}
	var out struct {
		Match      *bool  `json:"match"`
		VariantKey string `json:"variantKey"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out); err != nil {
		return false, "", fmt.Errorf("flipt: %s: %w", flag, err)
	}
	if out.Match == nil {
		return false, "", fmt.Errorf("flipt: %s: no match field", flag)
	}
	return *out.Match, out.VariantKey, nil
}

// RefreshInterval is the recorder's CONFIG_TTL_MS: how long Node reuses one reading of the dial.
const RefreshInterval = 15 * time.Second

// DefaultMaxAge is how long a reading stays current while every refresh fails. Past it there is no
// reading, and every batch with a feed event falls back to Node.
const DefaultMaxAge = time.Minute

// Rate is one variant flag read in the background and turned into a value by Parse, so a request
// never waits on Flipt. Value reports no reading until the first read succeeds, and again once the
// last success is older than MaxAge.
type Rate struct {
	read  func(ctx context.Context) (match bool, variantKey string, err error)
	parse func(variantKey string) float64
	// MaxAge is how long a reading outlives failed refreshes (0: DefaultMaxAge).
	MaxAge time.Duration
	// OnError, when set, sees every failed read.
	OnError func(err error)
	// Now is the clock (nil: time.Now).
	Now func() time.Time

	mu    sync.Mutex
	value float64
	at    time.Time // zero: never read successfully
}

// NewRate reads with read (Client.Variant of one flag, in production) and turns a matched variant key
// into the value with parse; no match is 0, as is a flag Flipt says does not exist (Node's evaluation
// of a missing key throws, getVariantDetailSync returns null and the recorder reads that as 0).
func NewRate(read func(ctx context.Context) (bool, string, error), parse func(string) float64) *Rate {
	return &Rate{read: read, parse: parse}
}

// Value is the current reading, and whether there is one.
func (r *Rate) Value() (float64, bool) {
	if r == nil {
		return 0, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.at.IsZero() || r.now().Sub(r.at) > r.maxAge() {
		return 0, false
	}
	return r.value, true
}

// Refresh reads the flag once. A success (or ErrFlagNotFound, read as 0) replaces the reading; any
// other failure keeps the last one until it is MaxAge old.
func (r *Rate) Refresh(ctx context.Context) {
	match, key, err := r.read(ctx)
	if err != nil && r.OnError != nil {
		r.OnError(err)
	}
	if err != nil && !errors.Is(err, ErrFlagNotFound) {
		return
	}
	v := 0.0
	if err == nil && match {
		v = r.parse(key)
	}
	r.mu.Lock()
	r.value, r.at = v, r.now()
	r.mu.Unlock()
}

func (r *Rate) maxAge() time.Duration {
	if r.MaxAge > 0 {
		return r.MaxAge
	}
	return DefaultMaxAge
}

func (r *Rate) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Run refreshes now and then on every tick until ctx ends.
func (r *Rate) Run(ctx context.Context, ticks <-chan time.Time) {
	r.Refresh(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			r.Refresh(ctx)
		}
	}
}

// Start runs the refresh every RefreshInterval in its own goroutine until ctx ends.
func (r *Rate) Start(ctx context.Context) {
	t := time.NewTicker(RefreshInterval)
	go func() {
		defer t.Stop()
		r.Run(ctx, t.C)
	}()
}
