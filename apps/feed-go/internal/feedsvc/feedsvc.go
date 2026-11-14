// Package feedsvc is the client half of the image feed service the Node app reads its image pages
// from when the `image-index-feed` flag is on (getAllImagesIndex → serveImagesFromFeedService in
// src/server/services/image.service.ts). The feed service picks and orders a page of image ids;
// Postgres then supplies the rows.
//
// Map is mapSearchInputToFeedQuery (src/server/services/feed-shadow.service.ts) for the inputs this
// service accepts, in 'primary' mode on the 'website' route; Client is fetchFeedAnswer +
// fetchFeedPrimary (src/server/services/feed-primary.service.ts).
package feedsvc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Limits of the mapper (feed-shadow.service.ts).
const (
	MaxOffset   = 20_000
	MaxPostIDs  = 50
	MaxLimit    = 200 // FEED_MAX_LIMIT
	maxExcluded = 100
	maxUsers    = 1000
)

var sorts = map[string]string{
	"Most Reactions": "reactions",
	"Most Collected": "collected",
	"Most Comments":  "comments",
	"Newest":         "newest",
	"Oldest":         "oldest",
}

var periodDays = map[string]int{"Day": 1, "Week": 7, "Month": 30, "Year": 365, "AllTime": 0}

var levels = []int{1, 2, 4, 8, 16, 32}

// Query is the search input of one getAllImagesIndex call, reduced to what this service accepts.
// Every list is as the Node input holds it at mapping time (after enforceBlockedBrowsingTags and
// applyHideChallengesExclusion have run on it).
type Query struct {
	BrowsingLevel   int
	ExcludedTagIDs  []int
	ExcludedUserIDs []int
	ModelID         int
	ModelVersionID  int
	Model3DID       int
	Types           []string
	// WithMeta is the input's own `withMeta` (not an `include: ['meta']`, which only the hydrate reads).
	WithMeta     bool
	FromPlatform bool
	DisableMinor bool
	DisablePoi   bool
	// ViewerID is `currentUserId` (0 = signed out).
	ViewerID int
	// PostIDs is set only by the gallery's post completion, which always takes the requested sort.
	PostIDs []int
	Sort    string
	Period  string
	// Limit is the per-call limit (the handler's overscan), before the feed's own clamp.
	Limit int
	// The cursor: CursorText when the client sent a string, else CursorNum (0 = none).
	CursorText string
	CursorNum  int
	// Inputs the mapper refuses as present (UNSUPPORTED_KEYS / UNSUPPORTED_FLAGS) that the parser
	// otherwise accepts or ignores.
	HasGeneration bool
	HasRemixOfID  bool
	RequiringMeta bool
}

// Refusal is why a Query cannot be sent to the feed. Rejected refusals are answered by Node with a
// BAD_REQUEST (DEEP_OFFSET, CURSOR_UNPARSED, an unknown sort); every other refusal is answered with
// an empty page (answerWithoutFeed's 'empty' branch).
type Refusal struct {
	Reason   string
	Rejected bool
}

func (r *Refusal) Error() string { return "feed query refused: " + r.Reason }

var (
	feedCursorRE   = regexp.MustCompile(`^feed:(\d{1,16}):(\d{1,12})$`)
	offsetCursorRE = regexp.MustCompile(`^(\d{1,12})(?:\|(\d{1,15}))?$`)
)

// ParseCursor is parseFeedCursor: a `feed:<a>:<b>` cursor as the feed's keyset `<a>|<b>`, or "".
func ParseCursor(s string) string {
	m := feedCursorRE.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	return m[1] + "|" + m[2]
}

// EncodeCursor is encodeFeedCursor: the feed's `<a>|<b>` as the client's `feed:<a>:<b>` (only the
// first `|` is replaced, as String#replace with a string pattern does).
func EncodeCursor(next string) string {
	return "feed:" + strings.Replace(next, "|", ":", 1)
}

func positive(v []int) []int {
	out := make([]int, 0, len(v))
	for _, n := range v {
		if n > 0 {
			out = append(out, n)
		}
	}
	return out
}

func uniq(v []int) []int {
	seen := make(map[int]bool, len(v))
	out := make([]int, 0, len(v))
	for _, n := range v {
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}

func join(v []int) string {
	parts := make([]string, len(v))
	for i, n := range v {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, ",")
}

// params is an ordered URLSearchParams: set() replaces in place, toString() keeps insertion order.
type params struct {
	keys []string
	vals map[string]string
}

func (p *params) set(k, v string) {
	if p.vals == nil {
		p.vals = map[string]string{}
	}
	if _, ok := p.vals[k]; !ok {
		p.keys = append(p.keys, k)
	}
	p.vals[k] = v
}

func (p *params) encode() string {
	parts := make([]string, len(p.keys))
	for i, k := range p.keys {
		parts[i] = url.QueryEscape(k) + "=" + url.QueryEscape(p.vals[k])
	}
	return strings.Join(parts, "&")
}

// Map is mapSearchInputToFeedQuery(input, 'primary', 'website') for this service's inputs: the feed
// query string, or the first reason the mapper refuses the input. Checks run in the mapper's order,
// because the first reason decides how Node answers.
func Map(q Query) (string, *Refusal) {
	skip := func(reason string) (string, *Refusal) { return "", &Refusal{Reason: reason} }
	reject := func(reason string) (string, *Refusal) { return "", &Refusal{Reason: reason, Rejected: true} }

	if q.HasGeneration {
		return skip("input:generation")
	}
	if q.HasRemixOfID {
		return skip("input:remixOfId")
	}
	if q.RequiringMeta {
		return skip("flag:requiringMeta")
	}
	postIDs := positive(q.PostIDs)
	if len(postIDs) > 0 {
		// The completion is the only caller with postIds, and it always takes the requested sort.
		if len(postIDs) > MaxPostIDs {
			return skip(fmt.Sprintf("postIds>%d", MaxPostIDs))
		}
		if q.Limit > MaxLimit {
			return skip(fmt.Sprintf("postIds:limit>%d", MaxLimit))
		}
	}
	sort, ok := sorts[q.Sort]
	if !ok {
		s := q.Sort
		if s == "" {
			s = "none"
		}
		return reject("sort:" + s) // answerWithoutFeed: 'sort:' is a BAD_REQUEST
	}
	period := q.Period
	if period == "" {
		period = "AllTime"
	}
	days, ok := periodDays[period]
	if !ok {
		return skip("period:" + period)
	}
	var lv []string
	for _, l := range levels {
		if q.BrowsingLevel&l != 0 {
			lv = append(lv, strconv.Itoa(l))
		}
	}
	if len(lv) == 0 {
		return skip("browsingLevel:0")
	}
	excludedTags := positive(q.ExcludedTagIDs)
	if len(excludedTags) > maxExcluded {
		return skip(fmt.Sprintf("excludedTags>%d", maxExcluded))
	}
	for _, t := range q.Types {
		if t != "image" && t != "video" && t != "audio" {
			return skip("types:" + strings.Join(q.Types, ","))
		}
	}
	var versionIDs string
	if q.ModelVersionID != 0 {
		versionIDs = strconv.Itoa(q.ModelVersionID)
	} else if q.ModelID != 0 {
		return skip("modelId")
	}

	// Parsed last: a cursor the feed cannot read is refused, so every other reason comes first.
	offset, before := 0, 0
	keyset := ""
	if q.CursorText != "" {
		if keyset = ParseCursor(q.CursorText); keyset == "" {
			m := offsetCursorRE.FindStringSubmatch(q.CursorText)
			if m == nil {
				return reject("cursor:unparsed")
			}
			offset, _ = strconv.Atoi(m[1])
			if m[2] != "" {
				entry, _ := strconv.Atoi(m[2])
				before = entry / 60_000 * 60_000
			}
		}
	} else if q.CursorNum > 0 {
		offset = q.CursorNum
	}
	if offset > MaxOffset {
		return reject(fmt.Sprintf("offset>%d", MaxOffset))
	}

	p := &params{}
	p.set("levels", strings.Join(lv, ","))
	if len(excludedTags) > 0 {
		p.set("excludedTags", join(excludedTags))
	}
	excludedUsers := uniq(positive(q.ExcludedUserIDs))
	if len(excludedUsers) > maxUsers {
		excludedUsers = excludedUsers[:maxUsers]
	}
	if len(excludedUsers) > 0 {
		p.set("excludedUserIds", join(excludedUsers))
	}
	if versionIDs != "" {
		p.set("versionIds", versionIDs)
	}
	if len(q.Types) > 0 {
		p.set("types", strings.Join(q.Types, ","))
	}
	if q.WithMeta {
		p.set("withMeta", "1")
	}
	if q.FromPlatform {
		p.set("fromPlatform", "1")
	}
	if q.DisableMinor {
		p.set("excludeMinor", "1")
	}
	if q.DisablePoi {
		p.set("excludePoi", "1")
		if q.ViewerID != 0 {
			p.set("viewerId", strconv.Itoa(q.ViewerID))
		}
	}
	if len(postIDs) > 0 {
		p.set("postIds", join(uniq(postIDs)))
	}
	if q.Model3DID != 0 {
		p.set("model3dIds", strconv.Itoa(q.Model3DID))
	}
	p.set("sort", sort)
	if days != 0 {
		p.set("periodDays", strconv.Itoa(days))
	}
	limit := 100
	if q.Limit > 0 {
		limit = min(q.Limit, MaxLimit)
	}
	p.set("limit", strconv.Itoa(limit))
	if keyset != "" {
		p.set("cursor", keyset)
	} else if offset != 0 {
		p.set("offset", strconv.Itoa(offset))
	}
	// Only Newest freezes a paged set at the first page's minute.
	if before != 0 && sort == "newest" {
		p.set("before", strconv.Itoa(before))
	}
	return p.encode(), nil
}

// Answer is the feed's reply (FeedAnswer).
type Answer struct {
	Status     int
	IDs        []int
	NextCursor string // the feed's own `<a>|<b>`, "" = end
}

// Shadow-traffic headers. feed-go only re-runs sampled requests, so its calls must not read as the
// site's served traffic. `x-request-source: shadow` is FeedQueryMode's non-serving value
// (feed-shadow.service.ts; Node's served reads send `primary`, and the feed service reads neither
// today). The feed service labels its route, estimate and duration metrics with `x-replay-id`
// (`replay`, "live" when absent), so this id is what keeps feed-go's load out of the live series.
const (
	RequestSource = "shadow"
	ReplayID      = "feed-go-shadow"
)

// Timeout is FEED_PRIMARY_TIMEOUT_MS.
const Timeout = 5 * time.Second

// Client calls the feed service (fetchFeedAnswer).
type Client struct {
	BaseURL string
	HTTP    *http.Client
	Timeout time.Duration // 0 = Timeout
}

// Fetch is `GET <base>/v1/feed?<query>`. A transport error or timeout is an error; a non-2xx status
// is an Answer with that status and no ids.
func (c *Client) Fetch(ctx context.Context, query string) (Answer, error) {
	timeout := c.Timeout
	if timeout == 0 {
		timeout = Timeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(c.BaseURL, "/")+"/v1/feed?"+query, nil)
	if err != nil {
		return Answer{}, err
	}
	req.Header.Set("x-request-source", RequestSource)
	req.Header.Set("x-replay-id", ReplayID)
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	res, err := hc.Do(req)
	if err != nil {
		return Answer{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
		return Answer{Status: res.StatusCode}, nil
	}
	var body struct {
		Items      []any `json:"items"`
		NextCursor any   `json:"nextCursor"`
	}
	dec := json.NewDecoder(io.LimitReader(res.Body, 8<<20))
	dec.UseNumber()
	if err := dec.Decode(&body); err != nil {
		return Answer{}, fmt.Errorf("feed answer: %w", err)
	}
	a := Answer{Status: res.StatusCode, IDs: Ints(body.Items)}
	if s, ok := body.NextCursor.(string); ok {
		a.NextCursor = s
	}
	return a, nil
}

// Ints is feed-shadow's `ints`: the positive integers of a decoded list (Number.isInteger(n) && n > 0),
// everything else dropped. Numbers arrive as json.Number (the decoder runs with UseNumber).
func Ints(v []any) []int {
	out := make([]int, 0, len(v))
	for _, e := range v {
		n, ok := e.(json.Number)
		if !ok {
			continue
		}
		f, err := n.Float64()
		if err != nil || f <= 0 || f != math.Trunc(f) || f > 1<<53 {
			continue
		}
		out = append(out, int(f))
	}
	return out
}
