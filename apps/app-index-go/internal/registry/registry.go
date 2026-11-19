// Package registry is the consumer side of the registry protocol's HTTP binding (civitai-registry
// spec/registry.md: "Subscribe", "Errors", "Bindings" → "HTTP"): one `GET /subscribe` whose
// `text/event-stream` response is read as events.
//
// Provenance: the event model and the SSE reader are ported from the registry-go reference
// implementation (internal/protocol: protocol.go ParseEvent, http.go Subscribe and
// Subscription.Next, at spec b7ded2e), trimmed to what a consumer needs. Two changes from it: lines
// are read with a bounded buffer (a line over MaxLine ends the stream instead of growing without
// bound), and a stream with no traffic for IdleTimeout (heartbeat comment lines count) is treated as
// lost, which is how the spec says a consumer detects a dropped connection ("Bindings": by the
// binding's pings, not by how long the stream has been quiet).
package registry

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// EventType names an SSE event of the binding.
type EventType string

// The event types of the protocol ("Subscribe").
const (
	Upsert   EventType = "upsert"
	Delete   EventType = "delete"
	Live     EventType = "live"
	Progress EventType = "progress"
	End      EventType = "end"
)

// Entity is one entity as its origin sent it. Fields this consumer does not read are dropped.
type Entity struct {
	URN     string          `json:"urn"`
	Schemas []string        `json:"schemas"`
	Rev     string          `json:"rev"`
	Body    json.RawMessage `json:"body"`
}

// Event is one protocol event. Cursor is empty on End, and on any event a registry cannot resume
// after (a snapshot upsert, typically).
type Event struct {
	Type   EventType
	Entity Entity // upsert
	URN    string // delete
	Cursor string // upsert, delete, live, progress
}

// Code is an error's name: the `error` field of the JSON body or of an `error` event ("Errors").
type Code string

// The errors of the core protocol and of the auth extension. Any other name is handled as
// Unavailable ("anything else": reconnect with the same cursor, with backoff).
const (
	BadRequest        Code = "bad_request"
	CursorExpired     Code = "cursor_expired"
	SlowConsumer      Code = "slow_consumer"
	Unavailable       Code = "unavailable"
	InvalidToken      Code = "invalid_token"
	InsufficientScope Code = "insufficient_scope"
)

// Error ends a subscription. Status is the HTTP status when it came before the stream started.
type Error struct {
	Code    Code
	Message string
	Status  int
}

func (e *Error) Error() string {
	if e.Message == "" {
		return string(e.Code)
	}
	return string(e.Code) + ": " + e.Message
}

// CodeOf is the error's name: Unavailable for an error that is not a protocol error (a dropped
// connection, a DNS failure).
func CodeOf(err error) Code {
	var pe *Error
	if errors.As(err, &pe) {
		return pe.Code
	}
	return Unavailable
}

// Request is a subscribe request. This consumer never sends `urns`, `filter` or `meta`.
type Request struct {
	Schema string
	Cursor string
}

// MaxLine bounds one SSE line. The largest app entity is a few KiB.
const MaxLine = 1 << 20

// Client opens subscriptions on one registry.
type Client struct {
	// BaseURL is the registry's URL; `/subscribe` is appended to its path.
	BaseURL string
	// Token, when set, is sent as `Authorization: Bearer` (auth extension, Consumers rule 2).
	Token string
	// HTTP is the client used; it must not set an overall Timeout (a stream is long-lived).
	HTTP *http.Client
	// IdleTimeout ends a stream that carried no bytes for this long (0: never). Registries send a
	// heartbeat comment line on idle streams, so set it to a few heartbeat intervals.
	IdleTimeout time.Duration
	// UserAgent is sent when set.
	UserAgent string
}

// Stream reads the events of one subscription.
type Stream struct {
	body   io.ReadCloser
	sc     *bufio.Scanner
	cancel context.CancelFunc
	ended  bool

	mu        sync.Mutex
	timer     *time.Timer
	resetIdle func()
	idle      bool
}

// Subscribe opens `GET {BaseURL}/subscribe`. An error before the stream starts is returned as an
// *Error named by the response body (or Unavailable when the body names none).
func (c *Client) Subscribe(ctx context.Context, req Request) (*Stream, error) {
	if req.Schema == "" {
		return nil, &Error{Code: BadRequest, Message: "schema is required"}
	}
	base, err := url.Parse(strings.TrimRight(c.BaseURL, "/"))
	if err != nil {
		return nil, &Error{Code: BadRequest, Message: "bad registry url"}
	}
	base.Path += "/subscribe"
	q := url.Values{"schema": {req.Schema}}
	if req.Cursor != "" {
		q.Set("cursor", req.Cursor)
	}
	base.RawQuery = q.Encode()

	sctx, cancel := context.WithCancel(ctx)
	hr, err := http.NewRequestWithContext(sctx, http.MethodGet, base.String(), http.NoBody)
	if err != nil {
		cancel()
		return nil, &Error{Code: BadRequest, Message: err.Error()}
	}
	hr.Header.Set("Accept", "text/event-stream")
	if c.Token != "" {
		hr.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if c.UserAgent != "" {
		hr.Header.Set("User-Agent", c.UserAgent)
	}
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	res, err := hc.Do(hr)
	if err != nil {
		cancel()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// The error text names the URL; callers log only the code.
		return nil, &Error{Code: Unavailable, Message: "connect failed"}
	}
	if res.StatusCode/100 != 2 {
		defer cancel()
		defer func() { _ = res.Body.Close() }()
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
		var body struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &body)
		if body.Error == "" {
			return nil, &Error{Code: Unavailable, Message: fmt.Sprintf("HTTP %d", res.StatusCode), Status: res.StatusCode}
		}
		return nil, &Error{Code: Code(body.Error), Message: body.Message, Status: res.StatusCode}
	}
	if mt, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type")); mt != "text/event-stream" {
		cancel()
		_ = res.Body.Close()
		return nil, &Error{Code: Unavailable, Message: "response is not text/event-stream"}
	}
	s := newStream(res.Body, cancel)
	if c.IdleTimeout > 0 {
		s.timer = time.AfterFunc(c.IdleTimeout, func() {
			s.mu.Lock()
			s.idle = true
			s.mu.Unlock()
			cancel()
		})
		s.resetIdle = func() { s.timer.Reset(c.IdleTimeout) }
	}
	return s, nil
}

// newStream reads events from an SSE body; cancel aborts the request it belongs to.
func newStream(body io.ReadCloser, cancel context.CancelFunc) *Stream {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64<<10), MaxLine)
	return &Stream{body: body, sc: sc, cancel: cancel}
}

// Next returns the next event. After End it returns io.EOF. A stream that closes without End is
// Unavailable, so a finished stream is never mistaken for a dropped one, and an `error` event is
// returned as its *Error. Events of a type this consumer does not know are skipped
// ("Consumers" rule 4).
func (s *Stream) Next() (Event, error) {
	if s.ended {
		return Event{}, io.EOF
	}
	var typ string
	var data []string
	for s.sc.Scan() {
		s.touch()
		line := strings.TrimSuffix(s.sc.Text(), "\r")
		if line == "" {
			if typ == "" && data == nil {
				continue
			}
			ev, skip, err := s.dispatch(typ, data)
			typ, data = "", nil
			if skip {
				continue
			}
			return ev, err
		}
		if strings.HasPrefix(line, ":") {
			continue // a comment: the heartbeat
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			typ = value
		case "data":
			data = append(data, value)
		}
		// `id` repeats the cursor already in `data`; `retry` is for EventSource.
	}
	s.ended = true
	if s.wasIdle() {
		return Event{}, &Error{Code: Unavailable, Message: "stream idle"}
	}
	if err := s.sc.Err(); errors.Is(err, bufio.ErrTooLong) {
		return Event{}, &Error{Code: Unavailable, Message: "line too long"}
	}
	return Event{}, &Error{Code: Unavailable, Message: "stream closed"}
}

// dispatch decodes one complete SSE event. skip is true for an event this consumer ignores.
func (s *Stream) dispatch(typ string, data []string) (ev Event, skip bool, err error) {
	if typ == "" {
		typ = "message"
	}
	payload := []byte(strings.Join(data, "\n"))
	if typ == "error" {
		s.ended = true
		var p struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(payload, &p)
		if p.Error == "" {
			p.Error = string(Unavailable)
		}
		return Event{}, false, &Error{Code: Code(p.Error), Message: p.Message}
	}
	ev, err = ParseEvent(EventType(typ), payload)
	if errors.Is(err, errUnknownEvent) {
		return Event{}, true, nil
	}
	if err != nil {
		s.ended = true
		return Event{}, false, &Error{Code: Unavailable, Message: err.Error()}
	}
	if ev.Type == End {
		s.ended = true
	}
	return ev, false, nil
}

var errUnknownEvent = errors.New("unknown event type")

// ParseEvent decodes the data of an SSE event of a known type.
func ParseEvent(typ EventType, data []byte) (Event, error) {
	switch typ {
	case Upsert, Delete, Live, Progress, End:
	default:
		return Event{}, fmt.Errorf("%w %q", errUnknownEvent, typ)
	}
	var p struct {
		Entity *Entity `json:"entity"`
		URN    string  `json:"urn"`
		Cursor string  `json:"cursor"`
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &p); err != nil {
			return Event{}, fmt.Errorf("bad %s event: %w", typ, err)
		}
	}
	ev := Event{Type: typ, Cursor: p.Cursor}
	switch typ {
	case Upsert:
		if p.Entity == nil || p.Entity.URN == "" {
			return Event{}, fmt.Errorf("bad %s event: no entity urn", typ)
		}
		ev.Entity = *p.Entity
	case Delete:
		if p.URN == "" {
			return Event{}, fmt.Errorf("bad %s event: no urn", typ)
		}
		ev.URN = p.URN
	case End:
		ev.Cursor = ""
	}
	return ev, nil
}

func (s *Stream) touch() {
	if s.resetIdle != nil {
		s.resetIdle()
	}
}

func (s *Stream) wasIdle() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.idle
}

// Close releases the connection.
func (s *Stream) Close() error {
	if s.timer != nil {
		s.timer.Stop()
	}
	s.cancel()
	return s.body.Close()
}
