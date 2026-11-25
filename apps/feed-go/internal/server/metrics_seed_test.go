package server

import (
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// The ratio counters exist at 0 from construction, so a new pod's first event is an increase rate()
// sees, not the creation of a series at 1 that it misses. Each series is looked up by Gather
// (metricValue), never by WithLabelValues, which would create the series it is meant to find.

// Every request outcome a path can reach is a 0 series per endpoint, and only those: served_cached
// on the single-model route alone (the only cached answer), on both modes; no served_empty on
// as-posts (its compute marks no trivial answer) nor on the single-model public route (its trivial
// answer, the not-found body, falls back there); region_blocked (the app's 451 written here) on every
// public route, serve mode only.
func TestRequestOutcomesAreSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	// serve: 6 public routes x served, served_empty, fallback, error, + v1-models-id served_cached,
	// - served_empty on as-posts and v1-models-id; shadow: 7 endpoints x the same 4, + v1-models-id
	// served_cached, - served_empty on as-posts; + region_blocked on the 6 public routes (serve only).
	if n := testutil.CollectAndCount(m.Requests); n != 6*4+1-2+7*4+1-1+6 {
		t.Fatalf("feed_go_requests_total has %d series at construction, want 57", n)
	}
	served := []string{"as-posts", "model-getall", "infinite", "v1-models", "v1-models-id", "v1-images"}
	all := append([]string{"model-associated"}, served...)
	for mode, endpoints := range map[string][]string{"serve": served, "shadow": all} {
		for _, e := range endpoints {
			outcomes := []string{"served", "fallback", "error"}
			if e != "as-posts" && (e != "v1-models-id" || mode == "shadow") {
				outcomes = append(outcomes, "served_empty")
			}
			for _, o := range outcomes {
				l := map[string]string{"feed_endpoint": e, "mode": mode, "outcome": o}
				if v, found := metricValue(t, reg, "feed_go_requests_total", l); !found || v != 0 {
					t.Errorf("requests%v = %v found=%v, want a 0 series", l, v, found)
				}
			}
		}
		l := map[string]string{"feed_endpoint": "v1-models-id", "mode": mode, "outcome": "served_cached"}
		if v, found := metricValue(t, reg, "feed_go_requests_total", l); !found || v != 0 {
			t.Errorf("requests%v = %v found=%v, want a 0 series", l, v, found)
		}
		l = map[string]string{"feed_endpoint": "as-posts", "mode": mode, "outcome": "served_cached"}
		if _, found := metricValue(t, reg, "feed_go_requests_total", l); found {
			t.Errorf("requests%v exists: as-posts has no cached answer", l)
		}
	}
	for _, l := range []map[string]string{
		{"feed_endpoint": "as-posts", "mode": "serve", "outcome": "served_empty"},
		{"feed_endpoint": "as-posts", "mode": "shadow", "outcome": "served_empty"},
		{"feed_endpoint": "v1-models-id", "mode": "serve", "outcome": "served_empty"},
	} {
		if _, found := metricValue(t, reg, "feed_go_requests_total", l); found {
			t.Errorf("requests%v exists, but its path cannot count it", l)
		}
	}
	for _, e := range served {
		l := map[string]string{"feed_endpoint": e, "mode": "serve", "outcome": "region_blocked"}
		if v, found := metricValue(t, reg, "feed_go_requests_total", l); !found || v != 0 {
			t.Errorf("requests%v = %v found=%v, want a 0 series", l, v, found)
		}
	}
	for _, e := range all {
		l := map[string]string{"feed_endpoint": e, "mode": "shadow", "outcome": "region_blocked"}
		if _, found := metricValue(t, reg, "feed_go_requests_total", l); found {
			t.Errorf("requests%v exists: the shadow never answers a 451", l)
		}
	}
	if _, found := metricValue(t, reg, "feed_go_requests_total", map[string]string{"feed_endpoint": "model-associated", "mode": "serve", "outcome": "served"}); found {
		t.Error("model-associated has no public route, yet a serve series exists")
	}
	if _, found := metricValue(t, reg, "feed_go_requests_total", map[string]string{"feed_endpoint": "v1-images", "mode": "serve", "outcome": "served_cached"}); found {
		t.Error("v1-images has no cached answer, yet a served_cached series exists")
	}
}

// Every shadow result the compare path can count is a 0 series per endpoint: the diff results
// (fields, order, membership) and the matches they are a share of, and only those.
func TestShadowResultsAreSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	// source="shadow": 7 endpoints x 10 results, less match_cached on the 6 without a cached answer,
	// order on v1-models-id (one model: ClassifyV1ModelID has no order) and match_empty on as-posts.
	// source="serve-parity" (the same family, seedServeParity): 3 replayed endpoints x 6 results, less
	// match_empty on as-posts. A curried vector collects the whole family.
	if n := testutil.CollectAndCount(m.ShadowResults); n != 7*10-6-1-1+3*6-1 {
		t.Fatalf("feed_go_shadow_compare_total has %d series at construction, want 62 + 17", n)
	}
	common := []string{"match", "fields", "membership", "unsupported", "deadline", "go_error", "bad_request"}
	for _, e := range []string{"as-posts", "v1-images", "infinite", "model-getall", "v1-models", "v1-models-id", "model-associated"} {
		results := append([]string(nil), common...)
		if e != "v1-models-id" {
			results = append(results, "order")
		}
		if e != "as-posts" {
			results = append(results, "match_empty")
		}
		for _, r := range results {
			if v, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": e, "result": r}); !found || v != 0 {
				t.Errorf("shadow_compare{%s,%s} = %v found=%v, want a 0 series", e, r, v, found)
			}
		}
	}
	if v, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": "v1-models-id", "result": "match_cached"}); !found || v != 0 {
		t.Errorf("shadow_compare{v1-models-id,match_cached} = %v found=%v, want a 0 series", v, found)
	}
	for _, c := range [][2]string{{"as-posts", "match_cached"}, {"v1-models-id", "order"}, {"as-posts", "match_empty"}} {
		if _, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": c[0], "result": c[1]}); found {
			t.Errorf("shadow_compare{%s,%s} exists, but the compare path cannot count it", c[0], c[1])
		}
	}
}

// The fallback reasons every compute can end in (Server.within: deadline, canceled, panic) are 0
// series for each mode's endpoints, with serve's `error` and `bulkhead`; serving, the
// request-determined reasons are seeded too (TestRequestFallbackReasonsAreSeeded); the other
// endpoint-specific reasons stay lazy.
func TestComputeFallbackReasonsAreSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	// serve: 6 routes x (bulkhead, error, deadline, canceled, panic); shadow: 7 x 3; probe: 4 x 3;
	// and the 201 request-determined serve series.
	if n := testutil.CollectAndCount(m.Fallbacks); n != 6*5+7*3+4*3+201 {
		t.Fatalf("feed_go_fallback_total has %d series at construction, want 264", n)
	}
	cases := map[string]struct {
		endpoints, reasons []string
	}{
		"serve":  {[]string{"as-posts", "model-getall", "infinite", "v1-models", "v1-models-id", "v1-images"}, []string{"bulkhead", "error", "deadline", "canceled", "panic"}},
		"shadow": {[]string{"as-posts", "v1-images", "infinite", "model-getall", "v1-models", "v1-models-id", "model-associated"}, []string{"deadline", "canceled", "panic"}},
		"probe":  {[]string{"as-posts", "infinite", "model-getall", "v1-images"}, []string{"deadline", "canceled", "panic"}},
	}
	for mode, c := range cases {
		for _, e := range c.endpoints {
			for _, r := range c.reasons {
				l := map[string]string{"feed_endpoint": e, "mode": mode, "reason": r}
				if v, found := metricValue(t, reg, "feed_go_fallback_total", l); !found || v != 0 {
					t.Errorf("fallback%v = %v found=%v, want a 0 series", l, v, found)
				}
			}
		}
	}
}

// Invariant guards (these series were seeded before the outcome seeding, and still are): the panic
// counter per where, and every devalue write result on the tRPC routes. The error counter is NOT
// seeded: its class label is ~70 values per endpoint and mode, far past what is ever reached.
func TestPanicsDevalueSeededErrorsLazy(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	if n := testutil.CollectAndCount(m.Panics); n != 4 {
		t.Errorf("feed_go_panics_total has %d series, want 4", n)
	}
	for _, w := range []string{"serve", "shadow", "probe", "serve-parity"} {
		if v, found := metricValue(t, reg, "feed_go_panics_total", map[string]string{"where": w}); !found || v != 0 {
			t.Errorf("panics{%s} = %v found=%v, want a 0 series", w, v, found)
		}
	}
	for _, e := range []string{"as-posts", "model-getall", "infinite"} {
		if v, found := metricValue(t, reg, "feed_go_devalue_write_total", map[string]string{"feed_endpoint": e, "result": "superjson_fallback"}); !found || v != 0 {
			t.Errorf("devalue_write{%s,superjson_fallback} = %v found=%v, want a 0 series", e, v, found)
		}
	}
	if n := testutil.CollectAndCount(m.Errors); n != 0 {
		t.Errorf("feed_go_errors_total has %d series at construction, want none (unbounded class)", n)
	}
}

// wantRequestFallbackReasons is RequestFallbackReasons as a literal: every reason a request alone
// decides, per public route, that the route's serve path can produce.
var wantRequestFallbackReasons = map[string][]string{
	EndpointAsPosts: {
		"method", "region-blocked", "crawler-user-agent",
		"bearer-malformed", "bearer-multiple-headers", "bearer-query-token", "verified-bot",
		"input-envelope", "input-invalid", "input-unknown-key", "input-sort", "input-include",
		"input-include-no-cosmetics", "input-cursor", "input-tools", "input-techniques",
		"input-collectionId", "input-collectionTagId", "input-postId", "input-postIds", "input-userId",
		"input-username", "input-hubId", "input-hubExcludedSources", "input-imageId", "input-reviewId",
		"input-skip", "input-ids", "input-prioritizedUserIds", "input-reactions", "input-followed",
		"input-hidden", "input-newCreators", "input-includeBaseModel", "input-pending",
		"input-pendingReviewOnly", "input-poiOnly", "input-minorOnly", "input-withTags", "input-jumpTo",
		"input-baseModels", "input-notPublished", "input-scheduled", "input-publishedOnly",
	},
	EndpointInfinite: {
		"method", "region-blocked", "crawler-user-agent",
		"bearer-malformed", "bearer-multiple-headers", "bearer-query-token",
		"input-envelope", "input-invalid", "input-unknown-key", "input-sort", "input-include",
		"input-cursor", "input-tools", "input-techniques",
		"input-collectionTagId", "ids-not-int4", "collection-id", "collection-tag-id",
		"infinite-user-zero", "prioritized-cursor", "collection-random-cursor",
		"input-postIds", "input-hubId", "input-hubExcludedSources", "input-imageId", "input-reviewId",
		"input-skip", "input-hidden", "input-includeBaseModel", "input-pendingReviewOnly",
		"input-poiOnly", "input-minorOnly", "input-withTags", "input-jumpTo", "input-notPublished",
		"input-scheduled", "input-publishedOnly",
	},
	EndpointModelGetAll: {
		"method", "region-blocked", "crawler-user-agent",
		"bearer-malformed", "bearer-multiple-headers", "bearer-query-token", "verified-bot",
		"input-envelope", "input-invalid", "input-unknown-key", "input-ids",
		"model-cursor", "model-sort-recently-added", "model-collection-id", "model-ids", "input-hidePaid",
		"input-query", "input-hidden", "input-followed", "input-newCreators", "input-modelVersionIds",
		"input-status", "input-needsReview", "input-pending", "input-supportsGeneration",
		"input-isFeatured", "input-availability", "input-publishedFrom", "input-publishedTo",
		"input-poiOnly", "input-minorOnly", "input-page",
	},
	EndpointV1Models: {
		"method", "region-blocked", "crawler-user-agent", "bearer-token",
		"v1-models-conditional", "v1-models-host", "v1-models-session-cookie", "v1-models-etag",
		"v1-models-query-encoding", "v1-models-authed-only", "v1-models-query", "v1-models-limit",
		"v1-models-input-number", "v1-models-sort", "v1-models-input-enum", "v1-models-input-duplicate",
		"v1-models-input-bool", "v1-models-ids", "v1-models-page-limit", "v1-models-cursor",
		"v1-models-tagname", "v1-models-user", "v1-models-rating", "v1-models-checkpointType",
		"v1-models-needsReview", "v1-models-paidAccess", "v1-models-hidePaid", "v1-models-onSale",
		"v1-models-modelVersionIds", "v1-models-supportsGeneration", "v1-models-fromPlatform",
		"v1-models-followed", "v1-models-newCreators", "v1-models-collectionId",
		"v1-models-collectionItemStatus", "v1-models-fileFormats", "v1-models-pending",
		"v1-models-collectionTagId", "v1-models-availability", "v1-models-disablePoi",
		"v1-models-disableMinor", "v1-models-isFeatured", "v1-models-poiOnly", "v1-models-minorOnly",
		"v1-models-allowNoCredit", "v1-models-allowCommercialUse", "v1-models-allowDerivatives",
		"v1-models-allowDifferentLicense", "v1-models-browsingLevel", "v1-models-excludedModelIds",
		"v1-models-excludedUserIds", "v1-models-excludedTagIds", "v1-models-excludedImageIds",
	},
	EndpointV1ModelsID: {
		"method", "region-blocked", "crawler-user-agent", "bearer-token",
		"v1-models-conditional", "v1-models-host", "v1-models-origin", "v1-models-path", "v1-models-id",
	},
	EndpointV1Images: {
		"method", "region-blocked", "crawler-user-agent", "bearer-token",
		"v1-images-conditional", "v1-images-session-cookie", "input-unknown-key",
		"v1-host", "v1-query-encoding", "v1-input-duplicate", "v1-input-number", "v1-input-username",
		"v1-input-period", "v1-input-type", "v1-input-ids", "v1-input-bool", "v1-image-id", "v1-tags",
		"v1-base-models", "v1-user-zero", "v1-model-only", "v1-sort", "v1-with-tags", "v1-cursor",
		"v1-legacy-cursor", "v1-page-limit",
	},
}

// The request-determined fallback reasons exist at 0 on a fresh registry, for mode serve on their
// own route only: a comparison of fallback rates over a window that subtracts them reads a new
// process's first such fallback as an increase, not as the birth of its series.
func TestRequestFallbackReasonsAreSeeded(t *testing.T) {
	got := RequestFallbackReasons()
	if !slices.Equal(slices.Sorted(maps.Keys(got)), slices.Sorted(slices.Values(ServedEndpoints))) {
		t.Fatalf("RequestFallbackReasons covers %v, want the served endpoints %v", slices.Sorted(maps.Keys(got)), ServedEndpoints)
	}
	total := 0
	for e, want := range wantRequestFallbackReasons {
		w := slices.Sorted(slices.Values(want))
		if g := got[e]; !slices.Equal(g, w) {
			t.Errorf("RequestFallbackReasons()[%s] =\n  %v\nwant\n  %v", e, g, w)
		}
		total += len(want)
	}
	if total != 201 {
		t.Errorf("the literal holds %d (endpoint, reason) pairs, want 201", total)
	}

	reg := prometheus.NewRegistry()
	NewMetrics(reg)
	for e, reasons := range wantRequestFallbackReasons {
		for _, r := range reasons {
			l := map[string]string{"feed_endpoint": e, "mode": "serve", "reason": r}
			if v, found := metricValue(t, reg, "feed_go_fallback_total", l); !found || v != 0 {
				t.Errorf("fallback%v = %v found=%v, want a 0 series", l, v, found)
			}
			for _, mode := range []string{"shadow", "probe"} {
				l := map[string]string{"feed_endpoint": e, "mode": mode, "reason": r}
				if _, found := metricValue(t, reg, "feed_go_fallback_total", l); found {
					t.Errorf("fallback%v exists: only the serve series are seeded", l)
				}
			}
		}
	}
	// Reachable nowhere, or not on that route: no phantom series.
	for _, c := range [][2]string{
		{EndpointV1Models, "v1-models-favorites"}, // authed-only wins (a 401)
		{EndpointV1Models, "v1-models-hidden"},    // authed-only wins (a 401)
		{EndpointV1Models, "v1-models-path"},      // the route's pattern is the list path itself
		{EndpointV1Models, "v1-models-origin"},    // the single-model route's check
		{EndpointV1ModelsID, "v1-models-etag"},    // the list's check
		{EndpointAsPosts, "bearer-token"},         // the tRPC routes: API keys not configured
		{EndpointInfinite, "verified-bot"},        // getInfinite reads a verified crawler
		{EndpointInfinite, "input-collectionId"},  // getInfinite answers a collection
		{EndpointV1Models, "bearer-malformed"},    // preflight refuses every credential first
		{EndpointAsPosts, "v1-host"},              // GET /api/v1/images's reason, not the gallery's
		{EndpointV1Images, "v1-path"},             // the route's pattern is the images path itself
		{EndpointV1Images, "v1-models-host"},      // the model routes' check
		{EndpointV1Images, "v1-images-session"},   // a resolved session: not the request alone
	} {
		l := map[string]string{"feed_endpoint": c[0], "mode": "serve", "reason": c[1]}
		if _, found := metricValue(t, reg, "feed_go_fallback_total", l); found {
			t.Errorf("fallback%v exists, but that route cannot produce it", l)
		}
	}
}

// requestDeterminedRe is the class of fallback reasons a request alone decides (its method, region,
// user agent, credential form, path, query or input), as names: anchored, as a label matcher is.
// It mirrors the reason set an external consumer of feed_go_fallback_total subtracts as
// request-determined (plus `bearer-token`, seeded here on the REST model routes): a change to either
// list must be made to both, and to unservedRequestReasons below.
var requestDeterminedRe = regexp.MustCompile(`^(?:input-.+|method|region-blocked|crawler-user-agent|verified-bot|bearer-token|bearer-malformed|bearer-multiple-headers|bearer-query-token|model-cursor|model-sort-recently-added|model-collection-id|model-ids|collection-id|collection-tag-id|collection-random-cursor|ids-not-int4|infinite-user-zero|prioritized-cursor|v1-images-(?:conditional|session-cookie)|v1-models-(?:origin|session-cookie|conditional|etag|host|path|id|ids|query|query-encoding|authed-only|sort|limit|page-limit|cursor|input-enum|input-number|input-bool|input-duplicate|tagname|user|rating|favorites|hidden|checkpointType|needsReview|paidAccess|hidePaid|onSale|modelVersionIds|supportsGeneration|fromPlatform|followed|newCreators|collectionId|collectionItemStatus|fileFormats|pending|collectionTagId|availability|disablePoi|disableMinor|isFeatured|poiOnly|minorOnly|allowNoCredit|allowCommercialUse|allowDerivatives|allowDifferentLicense|browsingLevel|excludedModelIds|excludedUserIds|excludedTagIds|excludedImageIds)|v1-(?:host|path|query-encoding|input-duplicate|input-number|input-username|input-period|input-type|input-ids|input-bool|image-id|tags|base-models|user-zero|model-only|sort|with-tags|cursor|legacy-cursor|page-limit))$`)

// unservedRequestReasons are the request-determined reasons no public route produces: `v1-path`
// (feed.ServeV1's nextPage on a path other than the images route's, which a shadow sample can carry
// and the public route, mounted on that exact path, cannot). Part of the same mirrored reason set as
// requestDeterminedRe: keep it in step with that consumer's list.
var unservedRequestReasons = []string{"v1-path"}

// prefixedReasonSites are the call sites that build a fallback reason at run time (`"input-" + k`),
// per file. A new one fails TestRequestFallbackReasonsAreEmitted until its reasons are seeded, or it
// is listed here as outside the request-determined class.
var prefixedReasonSites = map[string]int{
	"internal/feed/input.go":      2, // parseInput's unsupported keys; int4IDs (tools, techniques)
	"internal/modelfeed/input.go": 1, // Parse's unsupported keys
	"internal/v1models/query.go":  1, // ParseList's unported keys
	"internal/feed/infinite.go":   1, // feed-<refusal>: the feed service's query mapper refused it, not seeded
	"internal/feed/pager.go":      1, // feed-<refusal>: the same, on the posts gallery
}

var (
	literalReasonRe  = regexp.MustCompile(`fallback\.(?:New|Newf|Safef|NewfSafe|Wrap)\(\s*"([^"]+)"\s*(\+)?`)
	reasonCallSiteRe = regexp.MustCompile(`fallback\.(?:New|Newf|Safef|NewfSafe|Wrap)\(`)
)

// Every seeded reason is one the code emits, and every request-determined reason the code emits is
// seeded (or is one no public route produces: unservedRequestReasons). A reason written as a literal at a
// fallback call site is found in the module's source; a reason built from a key is produced by the
// route's own parser on an input holding that key.
func TestRequestFallbackReasonsAreEmitted(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	literals := map[string]bool{}
	prefixed := map[string]int{}
	scanned, sites := 0, 0
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == "testdata" || name == "node_modules" || (strings.HasPrefix(name, ".") && path != root) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		b, err := os.ReadFile(path) //nolint:gosec // G304: path is a source file of this module, from the walk
		if err != nil {
			return err
		}
		scanned++
		rel, _ := filepath.Rel(root, path)
		sites += len(reasonCallSiteRe.FindAll(b, -1))
		for _, m := range literalReasonRe.FindAllSubmatch(b, -1) {
			if len(m[2]) > 0 {
				prefixed[filepath.ToSlash(rel)]++
				continue
			}
			literals[string(m[1])] = true
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Positive controls: the scan read the module, and found its known literals and key-built sites.
	if scanned < 50 || sites < 200 || !literals["method"] || !literals["v1-models-conditional"] || !literals["bulkhead"] {
		t.Fatalf("scanned %d files, %d call sites (method %v, v1-models-conditional %v, bulkhead %v): the scan sees no module",
			scanned, sites, literals["method"], literals["v1-models-conditional"], literals["bulkhead"])
	}
	if !maps.Equal(prefixed, prefixedReasonSites) {
		t.Errorf("key-built reason sites = %v, want %v", prefixed, prefixedReasonSites)
	}

	seeded := map[string]bool{}
	for e, reasons := range RequestFallbackReasons() {
		for _, r := range reasons {
			seeded[r] = true
			if !requestDeterminedRe.MatchString(r) {
				t.Errorf("%s seeds %q, which no request alone decides", e, r)
			}
			if literals[r] {
				continue
			}
			if got := parsedReason(e, r); got != r {
				t.Errorf("%s seeds %q: no literal call site, and its parser on that key answers %q", e, r, got)
			}
		}
	}
	for r := range literals {
		if requestDeterminedRe.MatchString(r) && !seeded[r] && !slices.Contains(unservedRequestReasons, r) {
			t.Errorf("the code emits %q, a request-determined reason no route seeds", r)
		}
	}
	for _, r := range unservedRequestReasons {
		if !literals[r] {
			t.Errorf("unservedRequestReasons lists %q, which no call site emits", r)
		}
		if seeded[r] {
			t.Errorf("unservedRequestReasons lists %q, which a route seeds", r)
		}
	}
}

// parsedReason is the fallback reason the endpoint's own parser answers for an input holding only the
// key reason names (input-<key>, v1-models-<key>): a truthy value, or for an int4 id list one entry
// past int4. "" when the parser does not fall back.
func parsedReason(endpoint, reason string) string {
	if endpoint == EndpointV1Models {
		k, ok := strings.CutPrefix(reason, "v1-models-")
		if !ok {
			return ""
		}
		_, err := v1models.ParseList(k + "=1")
		return fallback.Reason(err)
	}
	k, ok := strings.CutPrefix(reason, "input-")
	if !ok {
		return ""
	}
	in := map[string]any{k: float64(1)}
	if k == "tools" || k == "techniques" {
		in = map[string]any{k: []any{float64(1 << 32)}}
	}
	var err error
	switch endpoint {
	case EndpointAsPosts:
		_, err = feed.Parse(in)
	case EndpointInfinite:
		_, err = feed.ParseInfinite(in)
	case EndpointModelGetAll:
		_, err = modelfeed.ParseWith(in, modelfeed.Ports{})
	default:
		return ""
	}
	return fallback.Reason(err)
}
