package evalharness

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
	"github.com/civitai/civitai/apps/feed-go/internal/server"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
)

// Answer is one call's outcome.
type Answer struct {
	// Status is the HTTP status (0 when there was no response).
	Status int
	Header http.Header
	Body   []byte
	// Err is a transport error (no response, or a body that could not be read). Timeout: it was the
	// per-call timeout. Canceled: the run itself was cancelled (never also Timeout).
	Err      error
	Timeout  bool
	Canceled bool
	Duration time.Duration
}

// Outcome is one case's score: the `results` row's verdict columns.
type Outcome struct {
	Verdict string
	Reason  string
	// ResultClass is the classifier's result of Go against the first Node answer (a bug's), or of the
	// second Node answer against the first (node_unstable's).
	ResultClass    string
	DiffCategories []string
	// UnstablePaths are node_unstable's proposed mask paths (evalcorpus.Masks syntax).
	UnstablePaths []string
}

// ReasonCanceled is the infra_miss reason of a case cut by the run's cancellation.
const ReasonCanceled = "canceled"

// Categories a comparison adds besides the body's and the headers'.
const (
	// CategoryStatus: the statuses differ.
	CategoryStatus = "status"
	// CategoryBodyShape: one side has a comparable body (a tRPC result, a REST JSON object) and the
	// other has none.
	CategoryBodyShape = "body:shape"
	// CategoryBodyUndecodable: the comparator refused a body.
	CategoryBodyUndecodable = "body:undecodable"
)

// Score is the verdict of one sandwich (n1, g, n2: Node, Go, Node) of an endpoint, comparing as sel
// (server.CompareSelection) does after removing masks (evalcorpus.Masks) from every body:
//
//  0. infra_miss `canceled`: the run was cancelled while the case was in flight;
//  1. infra_miss: either Node call failed (transport, timeout, 5xx), or their statuses differ, or a
//     Node 200 tRPC answer is not a tRPC result;
//  2. node_unstable: the two Node bodies differ (sel.Compare of N2 against N1); the proposed masks
//     are the differing categories as mask paths;
//  3. gap: Go answered the eval-mode stub (server.HandbackStatus) with a reason
//     (server.HandbackReasonHeader);
//  4. error: any other Go 5xx (the stub without a reason included), a timeout or a transport error;
//  5. Go answered: compared with N1 and with N2 (body by sel, the compared headers by
//     shadow.CompareResponseHeaders over sel.HeaderNames(sel.HeaderSet()), and the status). pass when
//     either side matches on all three, else bug with the N1 comparison's class and categories.
func Score(sel server.Selection, masks []string, n1, g, n2 Answer) Outcome {
	trpc := isTRPC(sel.Endpoint)
	if n1.Canceled || g.Canceled || n2.Canceled {
		// The run was cancelled mid-case: no side failed, so nothing is scored.
		return Outcome{Verdict: VerdictInfraMiss, Reason: ReasonCanceled}
	}
	if why := nodeFailure("node1", n1); why != "" {
		return Outcome{Verdict: VerdictInfraMiss, Reason: why}
	}
	if why := nodeFailure("node2", n2); why != "" {
		return Outcome{Verdict: VerdictInfraMiss, Reason: why}
	}
	if n1.Status != n2.Status {
		return Outcome{Verdict: VerdictInfraMiss, Reason: "node-status-mismatch"}
	}
	d1, ok1 := comparable(trpc, n1, masks)
	d2, ok2 := comparable(trpc, n2, masks)
	if trpc && n1.Status == http.StatusOK && (!ok1 || !ok2) {
		return Outcome{Verdict: VerdictInfraMiss, Reason: "node-bad-body"}
	}
	if ok1 != ok2 {
		return Outcome{Verdict: VerdictNodeUnstable, Reason: "body-shape", DiffCategories: []string{CategoryBodyShape}}
	}
	if ok1 {
		rep, err := sel.Compare(d2, d1)
		if err != nil {
			return Outcome{Verdict: VerdictInfraMiss, Reason: "node-bad-body"}
		}
		if !rep.Match {
			cats := reportCategories(rep)
			return Outcome{Verdict: VerdictNodeUnstable, Reason: "body", ResultClass: safeToken(sel.Classify(rep, d2, d1)),
				DiffCategories: cats, UnstablePaths: ProposedMasks(trpc, rep)}
		}
	}
	switch {
	case g.Timeout:
		return Outcome{Verdict: VerdictError, Reason: "go-timeout"}
	case g.Err != nil:
		return Outcome{Verdict: VerdictError, Reason: "go-transport"}
	case g.Status == server.HandbackStatus:
		reason := strings.TrimSpace(g.Header.Get(server.HandbackReasonHeader))
		if reason == "" {
			return Outcome{Verdict: VerdictError, Reason: "go-stub-without-reason"}
		}
		if !handbackReasonRE.MatchString(reason) {
			// A hand-back reason is a fallback reason (lowercase words and dashes): anything else is
			// never written as one.
			reason = "invalid-reason"
		}
		return Outcome{Verdict: VerdictGap, Reason: reason}
	case g.Status >= 500:
		return Outcome{Verdict: VerdictError, Reason: "go-status-" + strconv.Itoa(g.Status)}
	}
	gd, gok := comparable(trpc, g, masks)
	names := sel.HeaderNames(sel.HeaderSet())
	m1, class1, cats1 := compareSide(sel, names, g, gd, gok, n1, d1, ok1)
	m2, _, _ := compareSide(sel, names, g, gd, gok, n2, d2, ok2)
	if m1 || m2 {
		return Outcome{Verdict: VerdictPass}
	}
	return Outcome{Verdict: VerdictBug, ResultClass: safeToken(class1), DiffCategories: cats1}
}

// nodeFailure is why a Node call cannot serve as the oracle ("": it can).
func nodeFailure(which string, a Answer) string {
	switch {
	case a.Timeout:
		return which + "-timeout"
	case a.Err != nil:
		return which + "-transport"
	case a.Status >= 500:
		return which + "-status-5xx"
	case a.Status == 0:
		return which + "-no-status"
	}
	return ""
}

// compareSide compares Go's answer with one Node answer: whether it matches on body, headers and
// status, the body's class, and every differing category (no values).
func compareSide(sel server.Selection, names []string, g Answer, gd []byte, gok bool, n Answer, nd []byte, nok bool) (bool, string, []string) {
	var cats []string
	class := "match"
	switch {
	case gok && nok:
		rep, err := sel.Compare(gd, nd)
		if err != nil {
			class = "bad_request"
			cats = append(cats, CategoryBodyUndecodable)
			break
		}
		class = sel.Classify(rep, gd, nd)
		cats = append(cats, reportCategories(rep)...)
	case gok != nok:
		class = "fields"
		cats = append(cats, CategoryBodyShape)
	}
	gh := server.PickResponseHeaders(g.Header, names)
	nh := server.PickResponseHeaders(n.Header, names)
	headerDiffs := shadow.CompareResponseHeaders(gh, nh, names)
	for _, d := range headerDiffs {
		cats = append(cats, d.Category)
	}
	statusOK := g.Status == n.Status
	if !statusOK {
		cats = append(cats, CategoryStatus)
	}
	return class == "match" && len(headerDiffs) == 0 && statusOK, class, safeTokens(cats)
}

// reportCategories is a report's diff categories, deduplicated in order.
func reportCategories(rep *shadow.Report) []string {
	cats := make([]string, 0, len(rep.Diffs))
	for _, d := range rep.Diffs {
		cats = append(cats, d.Category)
	}
	return safeTokens(cats)
}

// comparable is an answer's compared document with the masks removed: a tRPC answer's `result.data`
// (the superjson envelope, as serve-parity decodes Node's replay), a REST answer's body when it is a
// JSON object. ok false: nothing comparable (an error envelope, a non-JSON body), and then only the
// status and headers are compared.
func comparable(trpc bool, a Answer, masks []string) ([]byte, bool) {
	doc := a.Body
	if trpc {
		var env struct {
			Result *struct {
				Data json.RawMessage `json:"data"`
			} `json:"result"`
		}
		if json.Unmarshal(a.Body, &env) != nil || env.Result == nil || len(env.Result.Data) == 0 {
			return nil, false
		}
		doc = env.Result.Data
	} else {
		var probe map[string]json.RawMessage
		if json.Unmarshal(a.Body, &probe) != nil {
			return nil, false
		}
	}
	if len(masks) == 0 {
		return doc, true
	}
	masked, err := ApplyMasks(doc, masks)
	if err != nil {
		return nil, false
	}
	return masked, true
}

// ApplyMasks is the JSON document doc with every mask path (evalcorpus.Masks syntax) removed: the
// member a path ends in deleted, or every element of an array it ends in with `[*]`. A path that
// matches nothing changes nothing. Numbers are kept as written.
func ApplyMasks(doc []byte, masks []string) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(doc))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	for _, m := range masks {
		segs, err := maskSegments(m)
		if err != nil {
			return nil, err
		}
		v = removePath(v, segs)
	}
	return marshalNoEscape(v)
}

// maskSegments splits a mask path into its segments (`*` for `[*]`).
func maskSegments(p string) ([]string, error) {
	if !evalcorpus.ValidMaskPath(p) {
		return nil, errors.New("evalharness: invalid mask path")
	}
	var segs []string
	rest := strings.TrimPrefix(p, "$")
	for rest != "" {
		if r, ok := strings.CutPrefix(rest, "[*]"); ok {
			segs = append(segs, "*")
			rest = r
			continue
		}
		rest = strings.TrimPrefix(rest, ".")
		end := strings.IndexAny(rest, ".[")
		if end < 0 {
			end = len(rest)
		}
		segs = append(segs, rest[:end])
		rest = rest[end:]
	}
	return segs, nil
}

func removePath(v any, segs []string) any {
	if len(segs) == 0 {
		return v
	}
	seg, last := segs[0], len(segs) == 1
	switch t := v.(type) {
	case map[string]any:
		if seg == "*" {
			return v
		}
		if last {
			delete(t, seg)
			return t
		}
		if c, ok := t[seg]; ok {
			t[seg] = removePath(c, segs[1:])
		}
		return t
	case []any:
		if seg != "*" {
			return v
		}
		if last {
			return []any{}
		}
		for i, e := range t {
			t[i] = removePath(e, segs[1:])
		}
		return t
	}
	return v
}

var maskNameRE = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

// handbackReasonRE is the shape of a fallback reason (fallback.Reason): `origin`, `model-getall-off`,
// `input-<key>`.
var handbackReasonRE = regexp.MustCompile(`^[a-z0-9][a-zA-Z0-9-]{0,63}$`)

// ProposedMasks turns a report's diff categories into mask paths (evalcorpus.Masks syntax): `$.json`
// (tRPC: the categories are relative to the envelope's `json`) or `$`, then each segment, `*` as
// `[*]`. A category with a segment no mask can name, or the root, proposes nothing. Sorted, unique.
func ProposedMasks(trpc bool, rep *shadow.Report) []string {
	var out []string
	for _, d := range rep.Diffs {
		if d.Category == "" {
			continue
		}
		var b strings.Builder
		b.WriteString("$")
		if trpc {
			b.WriteString(".json")
		}
		ok := true
		for _, seg := range strings.Split(d.Category, ".") {
			switch {
			case seg == "*":
				b.WriteString("[*]")
			case maskNameRE.MatchString(seg):
				b.WriteString("." + seg)
			default:
				ok = false
			}
		}
		if p := b.String(); ok && evalcorpus.ValidMaskPath(p) && !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	slices.Sort(out)
	return out
}
