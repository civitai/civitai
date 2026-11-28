// Package shadow checks this service against the Node app on live traffic without writing anything:
// the Node handlers' sampler (src/server/beacon/beacon-go-shadow.ts, flag `beacon-go-shadow`) posts
// what Node saw, what it answered and the tracker rows it wrote; this package rebuilds the request,
// computes this service's answer and rows, and compares the two — the write payloads byte for byte,
// not just the response.
package shadow

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/jsvalue"
)

// Sample is the sampler's POST body (buildBeaconGoShadowPayload in
// src/server/beacon/beacon-go-shadow-payload.ts).
type Sample struct {
	Method string
	// Target is the path of `req.url`; the query is never forwarded (it can hold an API key).
	Target string
	// Query marks the query: "" (none), "present", or "token" (a non-empty `token` parameter).
	Query string
	// Headers are the `req.headers` entries the outcome depends on, as Node holds them (already
	// folded, JS strings). Only the session cookies are forwarded from Cookie; an Authorization header
	// is forwarded as the literal `present` (only its presence matters here).
	Headers map[string]string
	// Body is `req.body` as a string: itself when Next left it a string (BodyIsString), else its
	// JSON.
	Body         string
	BodyIsString bool
	Node         *NodeSide
}

// NodeSide is what the Node handler did.
type NodeSide struct {
	Status int
	// Headers are the ComparedHeaders the response carried (a Set-Cookie forwarded redacted).
	Headers map[string]string
	Body    string
	Writes  []NodeWrite
	// HattedViews is how many hatted entities the /api/track/batch handler passed to awardViewPoints
	// (hattedImpressionEntities' length; absent, as on the other beacons, is 0). Those views earn event
	// points through Redis and a ClickHouse ledger, which this service never writes, so a batch with
	// any must be one this service falls back on.
	HattedViews int
}

// NodeWrite is one row the Node Tracker sent: the table and JSON.stringify(row), the exact bytes it
// POSTs.
type NodeWrite struct {
	Table string
	Body  string
}

// ErrInvalidSample is a sample that does not decode.
var ErrInvalidSample = errors.New("shadow: invalid sample")

// Decode parses a sample. It is read with this service's JS-semantics parser rather than
// encoding/json, so a string holding an unpaired surrogate (a JS string can) survives as itself
// instead of turning into U+FFFD.
func Decode(b []byte) (*Sample, error) {
	if !utf8.Valid(b) {
		return nil, ErrInvalidSample
	}
	v, err := jsvalue.Parse(string(b))
	if err != nil || !v.IsPlainObject() {
		return nil, ErrInvalidSample
	}
	o := v.O
	s := &Sample{}
	var ok bool
	if s.Method, ok = str(o, "method"); !ok || s.Method == "" {
		return nil, ErrInvalidSample
	}
	if s.Target, ok = str(o, "target"); !ok {
		return nil, ErrInvalidSample
	}
	if s.Query, ok = str(o, "query"); !ok || (s.Query != "" && s.Query != "present" && s.Query != "token") {
		return nil, ErrInvalidSample
	}
	if s.Headers, ok = strMap(o, "headers"); !ok {
		return nil, ErrInvalidSample
	}
	if s.Body, ok = str(o, "body"); !ok {
		return nil, ErrInvalidSample
	}
	isString, has := o.Get("bodyIsString")
	if !has || isString.Kind != jsvalue.Bool {
		return nil, ErrInvalidSample
	}
	s.BodyIsString = isString.B
	nv, has := o.Get("node")
	if !has || !nv.IsPlainObject() {
		return nil, ErrInvalidSample
	}
	n := &NodeSide{}
	st, has := nv.O.Get("status")
	if !has || st.Kind != jsvalue.Number || st.N != float64(int(st.N)) {
		return nil, ErrInvalidSample
	}
	n.Status = int(st.N)
	if n.Headers, ok = strMap(nv.O, "headers"); !ok {
		return nil, ErrInvalidSample
	}
	if n.Body, ok = str(nv.O, "body"); !ok {
		return nil, ErrInvalidSample
	}
	wv, has := nv.O.Get("writes")
	if !has || wv.Kind != jsvalue.Array {
		return nil, ErrInvalidSample
	}
	for _, w := range wv.A {
		if !w.IsPlainObject() {
			return nil, ErrInvalidSample
		}
		table, ok1 := str(w.O, "table")
		body, ok2 := str(w.O, "body")
		if !ok1 || !ok2 {
			return nil, ErrInvalidSample
		}
		n.Writes = append(n.Writes, NodeWrite{Table: table, Body: body})
	}
	if hv, has := nv.O.Get("hattedViews"); has {
		if hv.Kind != jsvalue.Number || hv.N < 0 || hv.N != float64(int(hv.N)) {
			return nil, ErrInvalidSample
		}
		n.HattedViews = int(hv.N)
	}
	s.Node = n
	return s, nil
}

func str(o *jsvalue.Object, k string) (string, bool) {
	v, ok := o.Get(k)
	if !ok || v.Kind != jsvalue.String {
		return "", false
	}
	return v.S, true
}

func strMap(o *jsvalue.Object, k string) (map[string]string, bool) {
	v, ok := o.Get(k)
	if !ok || !v.IsPlainObject() {
		return nil, false
	}
	out := make(map[string]string, v.O.Len())
	for _, key := range v.O.Keys() {
		e, _ := v.O.Get(key)
		if e.Kind != jsvalue.String {
			return nil, false
		}
		out[key] = e.S
	}
	return out, true
}

// Request rebuilds the beacon request from a sample.
func (s *Sample) Request(ctx context.Context) (*beacon.Request, error) {
	target := s.Target
	if target == "" || target[0] != '/' {
		target = "/" + target
	}
	if s.Query == "token" {
		// Stands in for the key the sampler withheld: the session resolver only asks whether one exists.
		target += "?token=present"
	}
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://beacon-go.shadow"+target, http.NoBody)
	if err != nil {
		return nil, ErrInvalidSample
	}
	// The session cookie names follow the site the browser addressed (AUTH_SESSION_COOKIE_MODE_BY_SITE).
	if h, ok := s.Headers["host"]; ok {
		hreq.Host = h
	}
	if c, ok := s.Headers["cookie"]; ok {
		hreq.Header.Set("Cookie", c)
	}
	if a, ok := s.Headers["authorization"]; ok {
		hreq.Header.Set("Authorization", a)
	}
	return &beacon.Request{
		Method:       s.Method,
		HasQuery:     s.Query != "" || strings.Contains(s.Target, "?"),
		Headers:      s.Headers,
		Body:         []byte(s.Body),
		BodyDecoded:  true,
		BodyIsString: s.BodyIsString,
		HTTP:         hreq,
	}, nil
}

// The compare results (beacon_go_shadow_compare_total{result}).
const (
	ResultMatch           = "match"
	ResultMismatchStatus  = "mismatch_status"
	ResultMismatchHeaders = "mismatch_headers"
	ResultMismatchBody    = "mismatch_body"
	ResultMismatchWrites  = "mismatch_writes"
	ResultFallback        = "fallback"
	ResultInvalid         = "invalid"
	ResultError           = "error"
	ResultDropped         = "dropped"
)

// Results lists every result, for seeding the counter.
var Results = []string{ResultMatch, ResultMismatchStatus, ResultMismatchHeaders, ResultMismatchBody,
	ResultMismatchWrites, ResultFallback, ResultInvalid, ResultError, ResultDropped}

// Verdict is one comparison. Diffs name what differed (header names, `body`, write indexes and the
// top-level row keys whose values differ) and never carry a value: rows hold an ip and a user agent.
type Verdict struct {
	Result string
	Reason string // the fallback reason, for ResultFallback
	Diffs  []string
}

// DiffPointsViews is the diff of an answered batch for which Node awarded hatted view points.
const DiffPointsViews = "points:views"

// Compare compares this service's outcome (or its error) with Node's. The first category that
// differs is the result, in order: status, headers, body, writes. Diffs lists every difference.
//
// Writes are compared table by table, in order within each table: the Node handler dispatches every
// sink without awaiting it, so rows of different tables (a search row, an impression insert, a feed
// row) reach the sampler in whatever order their promises settle, while one table's rows keep the
// order of the events. This service never writes a `feedEvents` row (it answers unsampled feed
// sessions only), so any feed row Node recorded for an answered batch is a mismatch. So is an
// answered batch for which Node awarded view points (HattedViews).
func Compare(out beacon.Outcome, err error, node *NodeSide) Verdict {
	if err != nil {
		if reason := fallback.Reason(err); reason != "" {
			return Verdict{Result: ResultFallback, Reason: reason}
		}
		return Verdict{Result: ResultError}
	}
	var v Verdict
	mark := func(result string, diff string) {
		if v.Result == "" {
			v.Result = result
		}
		v.Diffs = append(v.Diffs, diff)
	}
	if out.Response.Status != node.Status {
		mark(ResultMismatchStatus, "status")
	}
	for _, name := range beacon.ComparedHeaders {
		got, gok := out.Response.Get(name)
		want, wok := node.Headers[name]
		if gok != wok || got != want {
			mark(ResultMismatchHeaders, "header:"+name)
		}
	}
	if out.Response.Body != node.Body {
		mark(ResultMismatchBody, "body")
	}
	got, want := byTable(out.Writes), byTableNode(node.Writes)
	if len(out.Writes) != len(node.Writes) {
		mark(ResultMismatchWrites, "writes:count")
	} else {
		for _, table := range tablesOf(got, want) {
			g, w := got[table], want[table]
			if len(g) != len(w) {
				// Same total, different tables: each side has rows the other does not.
				mark(ResultMismatchWrites, "write:"+table+":table")
				continue
			}
			for i := range g {
				if !bytes.Equal(g[i], []byte(w[i])) {
					for _, k := range rowDiff(g[i], w[i]) {
						mark(ResultMismatchWrites, "write:"+table+":"+k)
					}
				}
			}
		}
	}
	if node.HattedViews > 0 {
		mark(ResultMismatchWrites, DiffPointsViews)
	}
	if v.Result == "" {
		v.Result = ResultMatch
	}
	return v
}

// byTable groups this service's rows by table, in order.
func byTable(writes []beacon.Write) map[string][][]byte {
	m := map[string][][]byte{}
	for _, w := range writes {
		m[w.Table] = append(m[w.Table], w.Body)
	}
	return m
}

func byTableNode(writes []NodeWrite) map[string][]string {
	m := map[string][]string{}
	for _, w := range writes {
		m[w.Table] = append(m[w.Table], w.Body)
	}
	return m
}

// tablesOf is every table either side wrote, sorted.
func tablesOf(got map[string][][]byte, want map[string][]string) []string {
	seen := map[string]bool{}
	var out []string
	for t := range got {
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	for t := range want {
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	sort.Strings(out)
	return out
}

// rowDiff names the top-level keys whose serialized values differ between two rows, `order` when
// the same keys and values come in a different order, and `unparsed` when either side is not a JSON
// object.
func rowDiff(got []byte, want string) []string {
	g, gerr := jsvalue.Parse(string(got))
	w, werr := jsvalue.Parse(want)
	if gerr != nil || werr != nil || !g.IsPlainObject() || !w.IsPlainObject() {
		return []string{"unparsed"}
	}
	keys := map[string]bool{}
	for _, k := range g.O.Keys() {
		keys[k] = true
	}
	for _, k := range w.O.Keys() {
		keys[k] = true
	}
	var diffs []string
	for k := range keys {
		gv, gok := g.O.Get(k)
		wv, wok := w.O.Get(k)
		if gok != wok || !bytes.Equal(jsvalue.Stringify(gv), jsvalue.Stringify(wv)) {
			diffs = append(diffs, k)
		}
	}
	sort.Strings(diffs)
	if len(diffs) == 0 {
		return []string{"order"}
	}
	return diffs
}
