// Package registry is the consumer side of the registry protocol's HTTP binding (civitai-registry
// spec/registry.md: "Subscribe", "Errors", "Bindings" → "HTTP"): one `GET /subscribe` whose
// `text/event-stream` response is read as events.
//
// Ported from the registry-go reference implementation (internal/protocol, spec b7ded2e).
//
// Liveness: the spec says a consumer detects a lost connection "by the binding's pings — not by
// how long the stream has been quiet: a live stream may be silent for any length of time"
// ("Bindings"). So nothing here times out a quiet stream or a slow response header. A dead
// connection is detected by the transport (NewHTTPClient): TCP keepalive probes on every
// connection, and HTTP/2 PING frames when the connection is HTTP/2. A connection the peer closes
// or resets ends the read at once.
package registry

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// EventType names an SSE event of the binding.
type EventType string

// The event types of the protocol ("Subscribe"), and Malformed for an event of one of those types
// that could not be decoded.
const (
	Upsert    EventType = "upsert"
	Delete    EventType = "delete"
	Live      EventType = "live"
	Progress  EventType = "progress"
	End       EventType = "end"
	Malformed EventType = "malformed"
)

// Entity is one entity as its origin sent it. Fields this consumer does not read are dropped.
type Entity struct {
	URN     string          `json:"urn"`
	Schemas []string        `json:"schemas"`
	Rev     string          `json:"rev"`
	Body    json.RawMessage `json:"body"`
	// Key is a private document's storage key, sent beside its body by the adapter's private feed only
	// (src/server/registry-adapter/private-feed.ts); empty on every other entity.
	Key string `json:"key,omitempty"`
	// Seq is a private document's `seq`, where its last write sits in its app namespace's write order,
	// sent beside its key by the same feed (body format k2). Zero when the entity carries none: every
	// other entity, and a private one from an adapter before k2.
	Seq int64 `json:"seq,omitempty"`
	// Version is the document's numeric version, sent by the adapter's level streams for a shared
	// document (src/server/registry-adapter/level-feed.ts) and by its private feed from body format
	// k3. CreatedAt and UpdatedAt are a shared document's, from the level streams. Zero on every
	// other entity, and Version zero on a private one from an adapter before k3.
	Version   int64  `json:"version,omitempty"`
	CreatedAt string `json:"createdAt,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

// Event is one protocol event. Cursor is empty on End, and on any event a registry cannot resume
// after (a snapshot upsert, typically).
type Event struct {
	Type   EventType
	Entity Entity // upsert
	URN    string // delete
	Cursor string // upsert, delete, live, progress; Malformed: the cursor it carried, if readable
	// Of is the type a Malformed event was sent as.
	Of EventType
	// Reason says why a Malformed event could not be decoded. It never contains the event's data.
	Reason string
	// Meta is the `meta` object a live, progress or end event carried, as sent (the spec's
	// `Event.meta`); nil when it carried none. The adapter's private feed names its head there,
	// `{"head":{"seq":N}}`, and an end its reason, `{"reason":"levels_on"}`. Read by the consumer;
	// nothing here interprets it.
	Meta json.RawMessage
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

// Request is a subscribe request. This consumer never sends `urns` or `filter`.
type Request struct {
	Schema string
	Cursor string
	// Token, when set, is this subscription's bearer token, in place of Client.Token.
	Token string
	// Meta, when set, is sent as the request's `meta` (a JSON object, as its compact text): the
	// adapter's level streams are named there, `{"level":4}`.
	Meta json.RawMessage
	// Headers, when set, are sent on the request beside the ones set here (the viewer's region
	// headers, session.Region). They never replace Accept, Authorization or User-Agent.
	Headers map[string]string
}

// MaxLine bounds one SSE line. The largest app entity is a few KiB.
const MaxLine = 1 << 20

// Transport liveness settings (NewHTTPClient).
const (
	// DialTimeout bounds establishing a connection. It is not a stream-quietness timeout.
	DialTimeout = 10 * time.Second
	// TCP keepalive: probe a connection idle for KeepAliveIdle, every KeepAliveInterval, and drop it
	// after KeepAliveCount unanswered probes.
	KeepAliveIdle     = 30 * time.Second
	KeepAliveInterval = 10 * time.Second
	KeepAliveCount    = 3
	// HTTP/2: send a PING when no frame arrived for H2PingAfter, drop the connection when it is not
	// answered within H2PingTimeout.
	H2PingAfter   = 30 * time.Second
	H2PingTimeout = 15 * time.Second
)

// NewHTTPClient is the client subscriptions are read with. It has no overall, response-header or
// idle timeout (a stream may be quiet for any length of time); dead connections are found by TCP
// keepalive and, over HTTP/2, by PING frames.
func NewHTTPClient() *http.Client {
	dialer := &net.Dialer{
		Timeout: DialTimeout,
		KeepAliveConfig: net.KeepAliveConfig{
			Enable: true, Idle: KeepAliveIdle, Interval: KeepAliveInterval, Count: KeepAliveCount,
		},
	}
	return &http.Client{Transport: &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         dialer.DialContext,
		TLSHandshakeTimeout: DialTimeout,
		ForceAttemptHTTP2:   true,
		HTTP2:               &http.HTTP2Config{SendPingTimeout: H2PingAfter, PingTimeout: H2PingTimeout},
	}}
}

// Client opens subscriptions on one registry.
type Client struct {
	// BaseURL is the registry's URL; `/subscribe` is appended to its path.
	BaseURL string
	// Token, when set, is sent as `Authorization: Bearer` (auth extension, Consumers rule 2).
	Token string
	// HTTP is the client used (NewHTTPClient in production); nil is http.DefaultClient.
	HTTP *http.Client
	// UserAgent is sent when set.
	UserAgent string
}

// Stream reads the events of one subscription.
type Stream struct {
	body   io.ReadCloser
	sc     *bufio.Scanner
	cancel context.CancelFunc
	ended  bool
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
	if len(req.Meta) > 0 {
		var compact bytes.Buffer
		if err := json.Compact(&compact, req.Meta); err != nil || compact.Len() == 0 || compact.Bytes()[0] != '{' {
			return nil, &Error{Code: BadRequest, Message: "meta must be a JSON object"}
		}
		q.Set("meta", compact.String())
	}
	base.RawQuery = q.Encode()

	sctx, cancel := context.WithCancel(ctx)
	hr, err := http.NewRequestWithContext(sctx, http.MethodGet, base.String(), http.NoBody)
	if err != nil {
		cancel()
		return nil, &Error{Code: BadRequest, Message: err.Error()}
	}
	for name, v := range req.Headers {
		switch http.CanonicalHeaderKey(name) {
		case "Accept", "Authorization", "User-Agent":
		default:
			hr.Header.Set(name, v)
		}
	}
	hr.Header.Set("Accept", "text/event-stream")
	token := c.Token
	if req.Token != "" {
		token = req.Token
	}
	if token != "" {
		hr.Header.Set("Authorization", "Bearer "+token)
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
	return newStream(res.Body, cancel), nil
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
// ("Consumers" rule 4); an event of a known type that cannot be decoded is returned as Malformed.
func (s *Stream) Next() (Event, error) {
	if s.ended {
		return Event{}, io.EOF
	}
	var typ, id string
	var hasID bool
	var data []string
	for s.sc.Scan() {
		line := strings.TrimSuffix(s.sc.Text(), "\r")
		if line == "" {
			if typ == "" && data == nil && !hasID {
				continue
			}
			ev, skip, err := s.dispatch(typ, data, id, hasID)
			typ, data, id, hasID = "", nil, "", false
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
		case "id":
			// The cursor again ("HTTP": an event with a cursor field carries it as the SSE id); read
			// only when the data cannot be.
			id, hasID = value, true
		}
	}
	s.ended = true
	if err := s.sc.Err(); errors.Is(err, bufio.ErrTooLong) {
		return Event{}, &Error{Code: Unavailable, Message: "line too long"}
	}
	return Event{}, &Error{Code: Unavailable, Message: "stream closed"}
}

// dispatch decodes one complete SSE event. skip is true for an event this consumer ignores.
func (s *Stream) dispatch(typ string, data []string, id string, hasID bool) (ev Event, skip bool, err error) {
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
	ev = ParseEvent(EventType(typ), payload)
	switch ev.Type {
	case "":
		return Event{}, true, nil
	case Malformed:
		if ev.Cursor == "" && hasID && ev.Of != End {
			ev.Cursor = id
		}
	case End:
		s.ended = true
	}
	return ev, false, nil
}

// ParseEvent decodes the data of an SSE event. An event of a type this consumer does not know is
// returned with an empty Type; one of a known type that cannot be decoded as Malformed, with the
// cursor it carried when that much could be read.
func ParseEvent(typ EventType, data []byte) Event {
	switch typ {
	case Upsert, Delete, Live, Progress:
	case End:
		// An end's only readable field is its `meta` (why the origin ended the stream); data that
		// cannot be read is an end all the same.
		var p struct {
			Meta json.RawMessage `json:"meta"`
		}
		if json.Unmarshal(data, &p) != nil || len(p.Meta) == 0 || p.Meta[0] != '{' {
			return Event{Type: End}
		}
		return Event{Type: End, Meta: p.Meta}
	default:
		return Event{}
	}
	malformed := func(cursor, reason string) Event {
		return Event{Type: Malformed, Of: typ, Cursor: cursor, Reason: reason}
	}
	var p struct {
		Entity *Entity         `json:"entity"`
		URN    string          `json:"urn"`
		Cursor string          `json:"cursor"`
		Meta   json.RawMessage `json:"meta"`
	}
	err := json.Unmarshal(data, &p)
	var typeErr *json.UnmarshalTypeError
	if err != nil && !errors.As(err, &typeErr) {
		// Not JSON. Perhaps only the entity is unreadable: the cursor may still be.
		var c struct {
			Cursor string `json:"cursor"`
		}
		_ = json.Unmarshal(data, &c)
		return malformed(c.Cursor, "data is not a "+string(typ)+" event")
	}
	if err != nil {
		// JSON with a field of the wrong type. An upsert whose URN was still read is kept, with no
		// body, so the consumer treats it as deleted (spec "Validity" rule 2); anything else is
		// Malformed. So is any event whose cursor is the unreadable field: storing it as empty
		// would mean "start over".
		var c struct {
			Cursor string `json:"cursor"`
		}
		if json.Unmarshal(data, &c) != nil {
			return malformed("", "the cursor of the "+string(typ)+" event is not a string")
		}
		switch {
		case typ == Upsert && p.Entity != nil && p.Entity.URN != "":
			p.Entity.Body = nil
		case typ == Delete && p.URN != "":
		default:
			return malformed(c.Cursor, "a field of the "+string(typ)+" event has the wrong type")
		}
	}
	ev := Event{Type: typ, Cursor: p.Cursor}
	switch typ {
	case Live, Progress:
		ev.Meta = p.Meta
	case Upsert:
		if p.Entity == nil || p.Entity.URN == "" {
			return malformed(p.Cursor, "upsert without an entity urn")
		}
		ev.Entity = *p.Entity
	case Delete:
		if p.URN == "" {
			return malformed(p.Cursor, "delete without a urn")
		}
		ev.URN = p.URN
	}
	return ev
}

// Close releases the connection.
func (s *Stream) Close() error {
	s.cancel()
	return s.body.Close()
}
