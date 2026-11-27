package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
)

// goldenInfinitePort is one image.getInfinite port behind its own serve switch (a feed.InfinitePorts
// field): the fixture config field that turns it on, and its served infinite fixtures, each with the reason the same request
// falls back with while the switch is off. One table for every port, so a port's switch and shadow
// cases are the same two tests.
type goldenInfinitePort struct {
	// on is the port's switch in a fixture's config.
	on func(fx *goldenFixture) *bool
	// fixtures maps a fixture name (infinite/<name>.json) to its switch-off fallback reason.
	fixtures map[string]string
}

// goldenInfinitePorts are the ports, keyed by their feed.InfinitePorts field
// (TestInfinitePortsTable holds the two sets equal).
var goldenInfinitePorts = map[string]goldenInfinitePort{
	"PublishedOnly": {
		on: func(fx *goldenFixture) *bool { return &fx.Config.ServePublishedOnly },
		fixtures: map[string]string{
			"published-only-own-picker":        "input-publishedOnly",
			"published-only-own-picker-cursor": "input-publishedOnly",
			"published-only-foreign-creator":   "input-publishedOnly",
			"published-only-signed-out":        "input-publishedOnly",
			"published-only-without-creator":   "input-publishedOnly",
			"published-only-own-username":      "input-publishedOnly",
		},
	},
	"PostIDs": {
		on: func(fx *goldenFixture) *bool { return &fx.Config.ServePostIDs },
		fixtures: map[string]string{
			"post-ids-signed-out":          "input-postIds",
			"post-ids-cursor":              "input-postIds",
			"post-ids-signed-in-oldest":    "input-postIds",
			"post-ids-beside-post-id":      "input-postIds",
			"post-ids-held-model":          "input-postIds",
			"post-ids-taken-down-stranger": "input-postIds",
			"post-ids-taken-down-owner":    "input-postIds",
		},
	},
	"SortRandom": {
		on: func(fx *goldenFixture) *bool { return &fx.Config.ServeSortRandom },
		fixtures: map[string]string{
			"collection-random-first-page":       "input-sort",
			"collection-random-cursor":           "input-sort",
			"collection-random-cursor-seed-wins": "input-sort",
			"collection-random-numeric-cursor":   "input-sort",
			"collection-random-cursor-zero-seed": "input-sort",
		},
	},
	"GallerySettingsMiss": {
		on: func(fx *goldenFixture) *bool { return &fx.Config.ServeGallerySettingsMiss },
		fixtures: map[string]string{
			"cold-gallery-settings-version-held":      "gallery-settings-miss",
			"cold-gallery-settings-ids-held-stranger": "gallery-settings-miss",
			"cold-gallery-settings-model-unheld":      "gallery-settings-miss",
		},
	},
	"HubID": {
		on: func(fx *goldenFixture) *bool { return &fx.Config.ServeHubID },
		fixtures: map[string]string{
			"hub-public-signed-out":               "input-hubId",
			"hub-public-cursor":                   "input-hubId",
			"hub-session-exclusions":              "input-hubId",
			"hub-private-owner-version-expansion": "input-hubId",
			"hub-private-moderator":               "input-hubId",
			"hub-private-signed-out":              "input-hubId",
			"hub-private-stranger":                "input-hubId",
			"hub-held-and-capped":                 "input-hubId",
			"hub-held-moderator":                  "input-hubId",
			"hub-capped-to-nothing":               "input-hubId",
			"hub-taken-down-stranger":             "input-hubId",
			"hub-taken-down-owner":                "input-hubId",
			"hub-no-source":                       "input-hubId",
			"hub-not-found":                       "input-hubId",
			"hub-route-not-a-union":               "input-hubId",
			"hub-beside-user-id":                  "input-hubId",
			"hub-index-feed-off":                  "input-hubId",
			"hub-id-zero":                         "input-hubId",
			"hub-excluded-sources-without-hub":    "input-hubExcludedSources",
		},
	},
	"JudgeScore": {
		on: func(fx *goldenFixture) *bool { return &fx.Config.ServeJudgeScore },
		fixtures: map[string]string{
			"collection-judge-score-served": "collection-judge-score",
		},
	},
	"HatTurfIgnored": {
		on: func(fx *goldenFixture) *bool { return &fx.Config.ServeHatTurfIgnored },
		fixtures: map[string]string{
			"hat-turf-signed-out-ignored": "infinite-hat-turf",
			"hat-turf-scoped-signed-in":   "infinite-hat-turf",
		},
	},
}

// goldenInfinitePortCase is one fixture of one port.
type goldenInfinitePortCase struct {
	field, name, offReason string
	on                     func(fx *goldenFixture) *bool
}

// goldenInfinitePortCases flattens goldenInfinitePorts.
func goldenInfinitePortCases() []goldenInfinitePortCase {
	var out []goldenInfinitePortCase
	for field, p := range goldenInfinitePorts {
		for name, reason := range p.fixtures {
			out = append(out, goldenInfinitePortCase{field: field, name: name, offReason: reason, on: p.on})
		}
	}
	return out
}

// Every feed.InfinitePorts field has a row in goldenInfinitePorts, and its fixture switch reaches
// that field in goldenSetupMode (a port left out of either is a switch no test turns on).
func TestInfinitePortsTable(t *testing.T) {
	typ := reflect.TypeOf(feed.InfinitePorts{})
	fields := map[string]bool{}
	for i := range typ.NumField() {
		fields[typ.Field(i).Name] = true
	}
	for field := range goldenInfinitePorts {
		if !fields[field] {
			t.Errorf("goldenInfinitePorts has %q, which feed.InfinitePorts does not", field)
		}
	}
	for field := range fields {
		p, ok := goldenInfinitePorts[field]
		if !ok {
			t.Errorf("feed.InfinitePorts.%s has no row in goldenInfinitePorts", field)
			continue
		}
		if len(p.fixtures) == 0 {
			t.Errorf("%s: no fixtures", field)
			continue
		}
		var name string
		for n := range p.fixtures {
			name = n
			break
		}
		fx := goldenLoad(t, filepath.Join(goldenDir, "infinite", name+".json"))
		for _, on := range []bool{true, false} {
			c := *fx
			*p.on(&c) = on
			env := goldenSetup(t, &c)
			if got := reflect.ValueOf(env.server.Infinite.Ports).FieldByName(field).Bool(); got != on {
				t.Errorf("%s fixture switched %v: InfinitePorts.%s = %v in goldenSetupMode", name, on, field, got)
			}
		}
	}
}

// With the gallery-settings-miss switch on but no hold computation configured
// (InfiniteDeps.GalleryHolds nil), the miss still falls back.
func TestInfiniteGallerySettingsMissNeedsComputation(t *testing.T) {
	fx := goldenLoad(t, filepath.Join(goldenDir, "infinite", "cold-gallery-settings-version-held.json"))
	env := goldenSetup(t, fx)
	env.server.Infinite.GalleryHolds = nil
	r, err := SyntheticInfiniteRequest(context.Background(), ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.server.computeInfinite(context.Background(), r); fallback.Reason(err) != "gallery-settings-miss" {
		t.Fatalf("no computation: %v (reason %q), want gallery-settings-miss", err, fallback.Reason(err))
	}
}

// goldenComputeInfinite runs a fixture's request through computeInfinite (write-back off).
func goldenComputeInfinite(t *testing.T, fx *goldenFixture) (*computed, error) {
	t.Helper()
	env := goldenSetup(t, fx)
	ctx := context.Background()
	r, err := SyntheticInfiniteRequest(ctx, ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	return env.server.computeInfinite(ctx, r)
}

// The port's switch decides it: on (the fixture's config), the request is computed and is Node's
// answer (the golden harness compares it); off, the same request is the fallback it always was.
func TestInfinitePortsSwitch(t *testing.T) {
	for _, pc := range goldenInfinitePortCases() {
		t.Run(pc.field+"/"+pc.name, func(t *testing.T) {
			fx := goldenLoad(t, filepath.Join(goldenDir, "infinite", pc.name+".json"))
			if !*pc.on(fx) {
				t.Fatalf("a port fixture must switch its port (%s) on", pc.field)
			}
			if fx.Expect.Fallback != "" {
				t.Fatalf("a port fixture must be served, not the %q fallback", fx.Expect.Fallback)
			}
			goldenRunInfinite(t, fx)
			off := *fx
			*pc.on(&off) = false
			if _, err := goldenComputeInfinite(t, &off); fallback.Reason(err) != pc.offReason {
				t.Fatalf("switch off: %v (reason %q), want %q", err, fallback.Reason(err), pc.offReason)
			}
		})
	}
}

// The shadow compares the ported shapes: a Node sample of each port fixture is computed and is a
// `match` (`match_empty` for a page with no image) with its switch on, and `unsupported` (the old
// fallback) with it off.
func TestInfinitePortsShadow(t *testing.T) {
	for _, pc := range goldenInfinitePortCases() {
		name, offReason := pc.name, pc.offReason
		for _, on := range []bool{true, false} {
			t.Run(pc.field+"/"+name+map[bool]string{true: "/on", false: "/off"}[on], func(t *testing.T) {
				fx := goldenLoad(t, filepath.Join(goldenDir, "infinite", name+".json"))
				node := fx.Expect.Envelope
				if len(node) == 0 {
					t.Fatalf("%s records no envelope", name)
				}
				want := "match"
				var env0 struct {
					JSON struct {
						Items []json.RawMessage `json:"items"`
					} `json:"json"`
				}
				if err := json.Unmarshal(node, &env0); err != nil {
					t.Fatal(err)
				}
				if len(env0.JSON.Items) == 0 {
					want = "match_empty"
				}
				if !on {
					c := *fx
					*pc.on(&c) = false
					fx, want = &c, "unsupported"
				}
				env := goldenSetup(t, fx)
				reg := prometheus.NewRegistry()
				s := env.server
				s.Metrics = NewMetrics(reg)
				s.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
				s.ShadowQueue = make(chan struct{}, 1)
				body, err := json.Marshal(ShadowRequest{Input: fx.Request.Input, Headers: env.headers, Node: node})
				if err != nil {
					t.Fatal(err)
				}
				w := httptest.NewRecorder()
				s.ShadowInfiniteHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/"+ProcedureInfinite, strings.NewReader(string(body))))
				if w.Code != http.StatusAccepted {
					t.Fatalf("code %d, want 202", w.Code)
				}
				waitFor(t, want, func() bool {
					v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointInfinite, "result": want})
					return v == 1 && len(s.ShadowQueue) == 0
				})
				if !on {
					if n, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointInfinite, "mode": "shadow", "reason": offReason}); n != 1 {
						t.Fatalf("shadow fallback %s = %v, want 1", offReason, n)
					}
				}
				if err := s.Close(context.Background()); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}
