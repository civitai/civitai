package evalcorpus

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
)

// goldenDir is the repository's golden fixtures (testdata/golden/README.md): all synthetic.
const goldenDir = "../../testdata/golden"

// testEnv maps the fixtures' synthetic hosts to their colors and restricts one region, GB.
var testEnv = Env{
	HostColors: browsing.HostColors{
		"green": {"green.example.test"},
		"blue":  {"blue.example.test", "site.example.test"},
		"red":   {"red.example.test", "mirror.red.example.test"},
	},
	RegionRules:      []browsing.RegionRule{{Region: "GB", Effective: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)}},
	RegionBlockRules: []browsing.RegionRule{{Region: "XB", Effective: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)}},
	Now:              time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC),
}

// goldenRequest is the request part every fixture format shares.
type goldenRequest struct {
	Input   string            `json:"input"`
	Query   string            `json:"query"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Session *struct {
		UserID int `json:"userId"`
	} `json:"session"`
}

type goldenFile struct {
	Fixture string        `json:"fixture"` // v1-models-headers/: the v1-models/ fixture it extends
	Request goldenRequest `json:"request"`
}

func readGolden(t *testing.T, path string) goldenFile {
	t.Helper()
	b, err := os.ReadFile(path) //nolint:gosec // G304: a fixture of this module's testdata
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return g
}

// goldenViewer is a fixture's viewer as far as its request says: signed out (a crawler when the
// edge marked it), or a signed-in user.
func goldenViewer(r goldenRequest) Viewer {
	if r.Session != nil {
		return Viewer{Class: ViewerUser, UserID: r.Session.UserID}
	}
	if r.Headers["x-civitai-verified-bot"] != "" {
		return Viewer{Class: ViewerCrawler}
	}
	return Viewer{Class: ViewerAnon}
}

// firstWaveDirs are the fixture directories whose requests are first-wave endpoints; otherDirs the
// ones that are not (yet). Together they must be every directory of testdata/golden: a new one has
// to be placed.
var (
	firstWaveDirs = map[string]string{
		"as-posts": EndpointAsPosts, "infinite": EndpointInfinite, "model-getall": EndpointModelGetAll,
		"v1-models": EndpointV1ModelsID, "v1-models-headers": EndpointV1ModelsID,
	}
	otherDirs = []string{"devalue", "metrics", "model-assoc", "region-blocked", "site-search", "v1-images"}
)

// goldenMinSigned is, per directory, how many fixtures at least must get a signature (the counts on
// the day this test was written: a fixture removed by mistake shows up here).
var goldenMinSigned = map[string]int{
	"as-posts": 35, "infinite": 150, "model-getall": 53, "v1-models": 13, "v1-models-headers": 5,
}

var sigRE = regexp.MustCompile(`^[0-9a-f]{16}$`)

// TestEveryGoldenFixtureHasASignature gives every first-wave fixture's request a signature, the
// list routes of v1-models (not first-wave) ErrUnsupportedEndpoint, and pins a handful exactly: the
// shape written out by hand from the rules in DESIGN.md §19.2, the hash computed from that text by
// an independent xxhash64 (Python's xxhash.xxh64_hexdigest), not by this package.
func TestEveryGoldenFixtureHasASignature(t *testing.T) {
	pinned := map[string]struct{ shape, sig string }{
		"as-posts/cold-event-decoration.json": {
			`{"endpoint":"as-posts","host":"green","input":{"browsingLevel":"1","limit":"3","modelId":"id","modelVersionId":"id","sort":"Most Reactions"},"region":"none","v":1,"viewer":{"browsingLevel":0,"class":"anon","hiddenPrefs":false,"self":false,"showNsfw":false}}`,
			"0e55623171bf650c",
		},
		"infinite/fallback-prioritized-system-user-no-version.json": {
			`{"endpoint":"infinite","host":"green","input":{"browsingLevel":"1","limit":"10","modelId":"id","prioritizedUserIds":"[-1]"},"region":"none","v":1,"viewer":{"browsingLevel":0,"class":"anon","hiddenPrefs":false,"self":false,"showNsfw":false}}`,
			"1ca2ba5c2ecc1bd8",
		},
		"infinite/collection-random-cursor-seed-wins.json": {
			`{"endpoint":"infinite","host":"blue","input":{"browsingLevel":"31","collectionId":"id","cursor":"random-seed","limit":"1","sort":"Random"},"region":"none","v":1,"viewer":{"browsingLevel":0,"class":"user","hiddenPrefs":false,"self":false,"showNsfw":false}}`,
			"f555b4fd304912db",
		},
		"model-getall/hot-official-pin-page2.json": {
			`{"endpoint":"model-getall","host":"blue","input":{"$paging":"cursor","$pin":"later-page","baseModels":"1:str","browsingLevel":"31","cursor":"entry:n|n","limit":"2","sort":"Hot"},"region":"none","v":1,"viewer":{"browsingLevel":0,"class":"user","hiddenPrefs":false,"self":false,"showNsfw":false}}`,
			"ad4e9ba2b81b6304",
		},
		"model-getall/base-model-single-moderator.json": {
			`{"endpoint":"model-getall","host":"blue","input":{"$paging":"none","$pin":"none","baseModels":"1:str","browsingLevel":"31","limit":"3","sort":"Most Downloaded"},"region":"none","v":1,"viewer":{"browsingLevel":0,"class":"user","hiddenPrefs":false,"self":false,"showNsfw":false}}`,
			"40696a7588041553",
		},
		"v1-models/detail-restricted-sfw-face.json": {
			`{"credential":"none","endpoint":"v1-models-id","host":"blue","input":{"$id":"id"},"region":"restricted","v":1,"viewer":{"browsingLevel":0,"class":"anon","hiddenPrefs":false,"self":false,"showNsfw":false}}`,
			"4bf121995d70c1c9",
		},
		"v1-models-headers/detail-session-cookie.json": {
			`{"credential":"session","endpoint":"v1-models-id","host":"blue","input":{"$id":"id"},"region":"open","v":1,"viewer":{"browsingLevel":0,"class":"anon","hiddenPrefs":false,"self":false,"showNsfw":false}}`,
			"50b8c11e4ee17a81",
		},
	}

	entries, err := os.ReadDir(goldenDir)
	if err != nil {
		t.Fatal(err)
	}
	var dirs []string
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	placed := make([]string, 0, len(firstWaveDirs)+len(otherDirs))
	for d := range firstWaveDirs {
		placed = append(placed, d)
	}
	placed = append(placed, otherDirs...)
	sort.Strings(placed)
	if strings.Join(dirs, ",") != strings.Join(placed, ",") {
		t.Fatalf("testdata/golden directories %v, want exactly %v (place a new one in firstWaveDirs or otherDirs)", dirs, placed)
	}

	signed := map[string]int{}
	unsupported := 0
	sigsSeen := map[string]string{}
	seenPinned := 0
	for dir, endpoint := range firstWaveDirs {
		files, err := filepath.Glob(filepath.Join(goldenDir, dir, "*.json"))
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range files {
			name := dir + "/" + filepath.Base(f)
			g := readGolden(t, f)
			req := g.Request
			if dir == "v1-models-headers" {
				base := readGolden(t, filepath.Join(goldenDir, "v1-models", g.Fixture))
				headers := map[string]string{}
				for k, v := range base.Request.Headers {
					headers[k] = v
				}
				for k, v := range g.Request.Headers {
					headers[k] = v
				}
				req = base.Request
				req.Headers = headers
			}
			if strings.HasPrefix(dir, "v1-models") && !strings.HasPrefix(req.Path, v1ModelsPrefix) {
				// The list route, GET /api/v1/models: not first-wave.
				_, err := Capture(Request{Endpoint: "v1-models", Path: req.Path, Query: req.Query, Headers: req.Headers}, goldenViewer(req), testEnv, Extra{})
				if !errors.Is(err, ErrUnsupportedEndpoint) {
					t.Errorf("%s: list route: want ErrUnsupportedEndpoint, got %v", name, err)
				}
				unsupported++
				continue
			}
			c, err := Capture(Request{Endpoint: endpoint, Input: req.Input, Path: req.Path, Query: req.Query, Headers: req.Headers}, goldenViewer(req), testEnv, Extra{})
			if err != nil {
				t.Errorf("%s: %v", name, err)
				continue
			}
			if !sigRE.MatchString(c.Signature) {
				t.Errorf("%s: signature %q is not 16 hex digits", name, c.Signature)
			}
			if c.Endpoint != endpoint {
				t.Errorf("%s: endpoint %q, want %q", name, c.Endpoint, endpoint)
			}
			if prev, ok := sigsSeen[c.Signature]; ok && prev != c.Shape {
				t.Errorf("%s: signature %s also hashes a different shape:\n %s\n %s", name, c.Signature, prev, c.Shape)
			}
			sigsSeen[c.Signature] = c.Shape
			signed[dir]++
			if p, ok := pinned[name]; ok {
				seenPinned++
				if c.Shape != p.shape {
					t.Errorf("%s: shape\n got  %s\n want %s", name, c.Shape, p.shape)
				}
				if c.Signature != p.sig {
					t.Errorf("%s: signature %s, want %s", name, c.Signature, p.sig)
				}
			}
		}
	}
	for dir, want := range goldenMinSigned {
		if signed[dir] < want {
			t.Errorf("%s: %d fixtures signed, want at least %d", dir, signed[dir], want)
		}
	}
	if seenPinned != len(pinned) {
		t.Errorf("%d pinned fixtures found, want %d (one was renamed or removed)", seenPinned, len(pinned))
	}
	// 29 list fixtures in v1-models/, 5 in v1-models-headers/.
	if unsupported != 34 {
		t.Errorf("%d v1-models list fixtures, want 34", unsupported)
	}
	// Positive control on the count of distinct shapes: the fixtures exist to cover different shapes,
	// so far more than one distinct signature must come out (a constant signature would pass every
	// per-fixture check above).
	if len(sigsSeen) < 80 {
		t.Errorf("%d distinct signatures over %d fixtures, want at least 80", len(sigsSeen), signed["as-posts"]+signed["infinite"]+signed["model-getall"]+signed["v1-models"]+signed["v1-models-headers"])
	}
}
