// Package evalcorpus turns one production request of a ported endpoint into an eval case: the
// request with every credential and personal identifier taken out, and its shape signature, the
// hash of what the request is made of (which keys it sends and what class of value each holds, who
// is asking, on which domain, from which kind of region) with every concrete value that does not
// change the code path (an id, a cursor's position, a search text) abstracted away. Two requests with
// the same signature take the same path through Node and through feed-go, as far as the classes can
// tell; a corpus keeps a few cases per signature, so its size follows the number of ways an endpoint
// is actually called, not its traffic (DESIGN.md §19).
//
// It is pure: no I/O, no clock unless the caller leaves Env.Now zero, nothing global but the
// embedded input schemas. Its callers are the capture (internal/evalcapture, DESIGN.md §19.6) and,
// later, the replay harness.
//
// Privacy, by construction rather than by review:
//   - Headers are an allow-list (keptHeaders): cookies, Authorization, the sampler's credential
//     header, the client address and user agent are never copied. What a credential was is kept as a
//     class only (Credential*).
//   - A `token` query pair, and any query pair or tRPC input key whose name holds a credential word,
//     is dropped from what is stored (the signature records that it was there).
//   - The viewer's own user id, username and collections never reach a Case: an input naming them is
//     rewritten to SelfPlaceholder / SelfCollectionPlaceholder and the descriptor says `self`.
//   - An input that does not decode is not stored at all (it cannot be searched for the viewer).
package evalcorpus

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/cespare/xxhash/v2"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
)

// The endpoints of the first wave, named as the server's feed_endpoint label names them.
const (
	EndpointAsPosts     = "as-posts"     // tRPC image.getImagesAsPostsInfinite
	EndpointInfinite    = "infinite"     // tRPC image.getInfinite
	EndpointModelGetAll = "model-getall" // tRPC model.getAll
	EndpointV1ModelsID  = "v1-models-id" // REST GET /api/v1/models/[id]
)

// Endpoints is every endpoint Capture accepts, in a fixed order.
var Endpoints = []string{EndpointAsPosts, EndpointInfinite, EndpointModelGetAll, EndpointV1ModelsID}

// ShapeVersion is the version of the value-class rules. It is part of every shape, so a change to
// the rules that would move a request to another class starts a new signature space instead of
// silently merging old cases with new ones. Bump it with any rule change.
const ShapeVersion = 1

// ErrUnsupportedEndpoint is a request of an endpoint this package has no rules for.
var ErrUnsupportedEndpoint = errors.New("evalcorpus: endpoint not in the first wave")

// Viewer classes (server.FeedViewer*).
const (
	ViewerAnon      = "anon"
	ViewerCrawler   = "crawler"
	ViewerBanned    = "banned"
	ViewerUser      = "user"
	ViewerModerator = "moderator"
)

// Placeholders written into a stored input in place of the viewer's own identifiers.
const (
	SelfPlaceholder           = "$self"
	SelfCollectionPlaceholder = "$self-collection"
)

// Request is one request as the capture sees it, credentials included: Capture is where they are
// taken out.
type Request struct {
	// Endpoint is one of Endpoints.
	Endpoint string
	// Input is a tRPC request's raw `input` query value (the superjson envelope); "" when none.
	Input string
	// Path and Query are a REST request's path and raw query string.
	Path, Query string
	// Headers are the request headers, names in any case. Several values of one header are joined
	// with ", " by the caller (cookies with "; ").
	Headers map[string]string
	// CredentialClass is the credential class of a request whose credential was taken out before it
	// got here (a corpus-only sample, DESIGN.md §19.6 T4): CredentialHeader or CredentialQuery, "" for
	// none. Read only when the request itself carries no credential (credentialClass reads
	// CredentialNone); then the case's class and its signature are exactly those of the same request
	// carrying a real credential of that class, so the corpus groups the two. Any other value is
	// ErrCredentialClass.
	CredentialClass string
}

// ErrCredentialClass is a Request.CredentialClass that is neither "", CredentialHeader nor
// CredentialQuery.
var ErrCredentialClass = errors.New("evalcorpus: credential class override must be header or query")

// HasCredential reports whether req still carries anything Capture reads as a credential or strips as
// one: an Authorization or SampleCredentialHeader header (present, even empty), a `token` query
// credential or a session cookie (credentialClass), or a query pair named like a credential
// (stripQuery). A caller that promises a request was stripped (a corpus-only sample) refuses one for
// which this is true: the one rule for what a credential is lives here.
func HasCredential(req Request) bool {
	h := lowerHeaders(req.Headers)
	if _, ok := h["authorization"]; ok {
		return true
	}
	if _, ok := h[SampleCredentialHeader]; ok {
		return true
	}
	if credentialClass(h, req.Query) != CredentialNone {
		return true
	}
	_, dropped := stripQuery(req.Query)
	return dropped
}

// Viewer is who made the request, as the caller resolved it from the session. The identity fields
// are read only to decide `self` and are never copied into a Case.
type Viewer struct {
	Class string
	// BrowsingLevel is the viewer's browsing level bitmask (0: none or unknown); ShowNsfw their
	// setting; HiddenPrefs whether their hidden preferences (users, tags, images, models) are
	// non-empty.
	BrowsingLevel int
	ShowNsfw      bool
	HiddenPrefs   bool
	// UserID and Username are the session user's (0 / "": none). CollectionIDs are collections the
	// viewer owns or contributes to, when the caller knows them.
	UserID        int
	Username      string
	CollectionIDs []int
}

// Env is what the classes of a request's host and region are read against.
type Env struct {
	// HostColors maps each domain color to its hosts (config's SERVER_DOMAIN_*). nil: every host is
	// HostUnmapped.
	HostColors browsing.HostColors
	// RegionRules are REGION_RESTRICTION_CONFIG, RegionBlockRules REGION_BLOCK_CONFIG.
	RegionRules, RegionBlockRules []browsing.RegionRule
	// Now is the instant rules are evaluated at (zero: time.Now()).
	Now time.Time
}

// Host classes besides the colors.
const (
	HostOther    = "other"    // a host on no color's list
	HostUnmapped = "unmapped" // Env.HostColors is nil
)

// Region classes.
const (
	RegionNone       = "none"       // no country header
	RegionOpen       = "open"       // a country on no rule list
	RegionRestricted = "restricted" // on REGION_RESTRICTION_CONFIG (no NSFW)
	RegionBlocked    = "blocked"    // on REGION_BLOCK_CONFIG (the 451)
)

// Extra is what the caller knows of the answer, when it does (both optional, both small fixed sets
// the caller chooses). Both must describe the REFERENCE answer, Node's (e.g. Response "200" / "404" /
// "400", Outcome the class of Node's result), never feed-go's: a signature that moved whenever a
// feed-go handback was closed would split one calling shape across corpus generations.
type Extra struct {
	Response, Outcome string
}

// ViewerDescriptor is the viewer as a Case stores it.
type ViewerDescriptor struct {
	Class         string `json:"class"`
	BrowsingLevel int    `json:"browsingLevel"`
	ShowNsfw      bool   `json:"showNsfw"`
	HiddenPrefs   bool   `json:"hiddenPrefs"`
	// Self is whether the input named the viewer's own user or collection (now a placeholder).
	Self bool `json:"self"`
}

// Case is one stored eval case: the request as it can be replayed (credentials and the viewer's
// identity taken out) and its signature.
type Case struct {
	Endpoint string `json:"endpoint"`
	// Signature is the shape's xxhash64, 16 lowercase hex digits.
	Signature string `json:"signature"`
	// Shape is the canonical JSON the signature hashes.
	Shape string `json:"shape"`
	// Input (tRPC), Path and Query (REST) as stored.
	Input string `json:"input,omitempty"`
	Path  string `json:"path,omitempty"`
	Query string `json:"query,omitempty"`
	// Headers are the kept headers (keptHeaders), names lowercased.
	Headers map[string]string `json:"headers"`
	// Credential is the credential class (Credential*).
	Credential string           `json:"credential"`
	Viewer     ViewerDescriptor `json:"viewer"`
}

// Capture builds the case of one request: its stored form and its signature.
func Capture(req Request, v Viewer, env Env, extra Extra) (*Case, error) {
	rules, ok := endpointRules[req.Endpoint]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnsupportedEndpoint, req.Endpoint)
	}
	headers := lowerHeaders(req.Headers)
	c := &Case{
		Endpoint:   req.Endpoint,
		Headers:    keptHeaderValues(headers),
		Credential: credentialClass(headers, req.Query),
	}
	overridden := false
	switch req.CredentialClass {
	case "":
	case CredentialHeader, CredentialQuery:
		if c.Credential == CredentialNone {
			c.Credential, overridden = req.CredentialClass, true
		}
	default:
		return nil, fmt.Errorf("%w: %q", ErrCredentialClass, req.CredentialClass)
	}
	self := selfMatcher{viewer: v}
	var input map[string]any
	if rules.rest {
		id, q, path, inputShape := restShape(req.Path, req.Query, &self)
		c.Path, c.Query = path, q
		input = inputShape
		if id != "" {
			input["$id"] = id
		}
		// A real query credential is a `token` pair, which restShape records as $credential-param:
		// the override records it too, so the two sign alike.
		if overridden && c.Credential == CredentialQuery {
			input["$credential-param"] = "present"
		}
	} else {
		stored, inputShape := trpcShape(req.Input, &self, rules)
		c.Input = stored
		input = inputShape
	}
	c.Viewer = ViewerDescriptor{
		Class: v.Class, BrowsingLevel: v.BrowsingLevel, ShowNsfw: v.ShowNsfw, HiddenPrefs: v.HiddenPrefs,
		Self: self.matched,
	}
	shape := map[string]any{
		"v":        ShapeVersion,
		"endpoint": req.Endpoint,
		"input":    input,
		// A map, not the struct: encoding/json sorts map keys but writes struct fields in declaration
		// order, and the shape is sorted at every level.
		"viewer": map[string]any{
			"class": c.Viewer.Class, "browsingLevel": c.Viewer.BrowsingLevel, "showNsfw": c.Viewer.ShowNsfw,
			"hiddenPrefs": c.Viewer.HiddenPrefs, "self": c.Viewer.Self,
		},
		"host":   hostClass(env.HostColors, headers["host"]),
		"region": regionClass(env, headers),
	}
	if rules.rest {
		shape["credential"] = c.Credential
	}
	if extra.Response != "" {
		shape["response"] = extra.Response
	}
	if extra.Outcome != "" {
		shape["outcome"] = extra.Outcome
	}
	canon, err := canonicalJSON(shape)
	if err != nil {
		return nil, err
	}
	c.Shape = canon
	c.Signature = Signature(canon)
	return c, nil
}

// Signature is the xxhash64 of a canonical shape, as 16 lowercase hex digits.
func Signature(canonicalShape string) string {
	return fmt.Sprintf("%016x", xxhash.Sum64String(canonicalShape))
}

// canonicalJSON is v as encoding/json writes it (object keys sorted, as it sorts map keys), with no
// HTML escaping and no trailing newline: the same value always gives the same bytes.
func canonicalJSON(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

// HostClass is the host class a Case's shape records for a request to host (the `host` of its shape):
// the host's domain color, HostOther, or HostUnmapped when colors is nil.
func HostClass(colors browsing.HostColors, host string) string { return hostClass(colors, host) }

// hostClass is the host's domain color, HostOther, or HostUnmapped.
func hostClass(colors browsing.HostColors, host string) string {
	if colors == nil {
		return HostUnmapped
	}
	if c := colors.ColorOf(host); c != "" {
		return c
	}
	return HostOther
}

// regionClass reads the region as the server does (countryOf: x-isuk, then cf-ipcountry; and
// cf-region-code for a US state).
func regionClass(env Env, headers map[string]string) string {
	country := headers["cf-ipcountry"]
	if v := headers["x-isuk"]; v == "true" || v == "1" {
		country = "GB"
	}
	if country == "" {
		return RegionNone
	}
	now := env.Now
	if now.IsZero() {
		now = time.Now()
	}
	region := headers["cf-region-code"]
	switch {
	case browsing.IsRegionRestricted(env.RegionBlockRules, country, region, now):
		return RegionBlocked
	case browsing.IsRegionRestricted(env.RegionRules, country, region, now):
		return RegionRestricted
	}
	return RegionOpen
}

// selfMatcher decides whether an input value names the viewer, and records that one did.
type selfMatcher struct {
	viewer  Viewer
	matched bool
}

// numberValue is v as Number() reads a JSON number or a string (surrounding space trimmed, any
// decimal or exponent form), when that is an integer.
func numberValue(v any) (int64, bool) {
	var str string
	switch t := v.(type) {
	case json.Number:
		str = t.String()
	case string:
		str = strings.TrimSpace(t)
	default:
		return 0, false
	}
	f, err := strconv.ParseFloat(str, 64)
	if err != nil || f != math.Trunc(f) || math.Abs(f) > 1<<53 {
		return 0, false
	}
	return int64(f), true
}

// userID reports whether v, read as Number() reads it (numberValue), is the viewer's user id.
func (s *selfMatcher) userID(v any) bool {
	if s.viewer.UserID == 0 {
		return false
	}
	n, ok := numberValue(v)
	if ok && n == int64(s.viewer.UserID) {
		s.matched = true
		return true
	}
	return false
}

// username reports whether v is the viewer's username (case-insensitively: a stored case must not
// keep the name under any spelling).
func (s *selfMatcher) username(v any) bool {
	str, ok := v.(string)
	if !ok || s.viewer.Username == "" {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(str), s.viewer.Username) {
		s.matched = true
		return true
	}
	return false
}

// collection reports whether v is one of the viewer's collections.
func (s *selfMatcher) collection(v any) bool {
	n, ok := numberValue(v)
	if !ok {
		return false
	}
	for _, id := range s.viewer.CollectionIDs {
		if int64(id) == n {
			s.matched = true
			return true
		}
	}
	return false
}

// sortedKeys is m's keys, sorted.
func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// queryPair is one `&`-separated pair of a raw query string.
type queryPair struct{ raw, key, value string }

// splitQuery splits a raw query on `&` as URLSearchParams does, unescaping leniently (an invalid
// escape is kept as written; `+` is a space).
func splitQuery(raw string) []queryPair {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, "&")
	out := make([]queryPair, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			continue
		}
		k, v, _ := strings.Cut(p, "=")
		out = append(out, queryPair{raw: p, key: lenientUnescape(k), value: lenientUnescape(v)})
	}
	return out
}

func lenientUnescape(s string) string {
	u, err := url.QueryUnescape(s)
	if err != nil {
		return strings.ReplaceAll(s, "+", " ")
	}
	return u
}
