package policy

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"testing"
	"time"
)

// vectorFile is testdata/golden/vectors.json, written by testdata/golden/gen.ts from the REAL Node
// code (the site's and the registry adapter's own functions). Never edit it by hand.
type vectorFile struct {
	Config struct {
		Restriction string `json:"REGION_RESTRICTION_CONFIG"`
		Block       string `json:"REGION_BLOCK_CONFIG"`
	} `json:"config"`
	Users   map[string]User `json:"users"`
	Vectors []vector        `json:"vectors"`
}

type vector struct {
	Country *string  `json:"country"`
	Region  *string  `json:"region"`
	IsUK    *string  `json:"isUk"`
	Context string   `json:"context"`
	Host    *string  `json:"host"`
	User    *string  `json:"user"`
	At      string   `json:"at"`
	Want    Decision `json:"want"`
}

func loadVectors(t testing.TB) vectorFile {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/golden/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var f vectorFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func vectorEngine(t testing.TB, f vectorFile) *Engine {
	t.Helper()
	restricted, err := ParseRules(f.Config.Restriction, RegionRestrictionDefault())
	if err != nil {
		t.Fatal(err)
	}
	blocked, err := ParseRules(f.Config.Block, RegionBlockDefault())
	if err != nil {
		t.Fatal(err)
	}
	return NewEngine(restricted, blocked)
}

func (v vector) input(t testing.TB, users map[string]User) Input {
	t.Helper()
	at, err := time.Parse(time.RFC3339Nano, v.At)
	if err != nil {
		t.Fatal(err)
	}
	in := Input{
		Context:  v.Context,
		Location: Location{Country: v.Country, Region: v.Region, IsUK: v.IsUK},
		At:       at,
	}
	if v.Host != nil {
		in.Host = *v.Host
	}
	if v.User != nil {
		u, ok := users[*v.User]
		if !ok {
			t.Fatalf("vector names user %q, which the file does not define", *v.User)
		}
		in.Viewer, in.User = SignedIn, u
	}
	return in
}

func str(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return fmt.Sprintf("%q", *p)
}

// TestGolden decides every vector and compares the whole decision. The positive controls below
// (TestGoldenMatrix) make sure the file still holds the matrix this test is meant to cover.
func TestGolden(t *testing.T) {
	f := loadVectors(t)
	e := vectorEngine(t, f)
	failed := 0
	for i, v := range f.Vectors {
		got, err := e.Decide(v.input(t, f.Users))
		if err != nil {
			t.Fatalf("vector %d: %v", i, err)
		}
		if got.Ratings == nil {
			got.Ratings = []string{}
		}
		if !slices.Equal(got.Ratings, v.Want.Ratings) || got.UnknownRating != v.Want.UnknownRating ||
			got.BrowsingLevel != v.Want.BrowsingLevel || got.RegionHold != v.Want.RegionHold || got.Reason != v.Want.Reason {
			failed++
			if failed <= 20 {
				t.Errorf("vector %d (context=%s country=%s region=%s isUk=%s host=%s user=%s at=%s):\n got  %+v\n want %+v",
					i, v.Context, str(v.Country), str(v.Region), str(v.IsUK), str(v.Host), str(v.User), v.At, got, v.Want)
			}
		}
	}
	if failed > 0 {
		t.Fatalf("%d of %d vectors disagree with the Node code", failed, len(f.Vectors))
	}
	t.Logf("%d vectors agree", len(f.Vectors))
}

// TestGoldenMatrix pins the matrix the vectors must span, so a generator change that drops a
// dimension (and with it the only check on that part of the port) fails here rather than passing
// with less to check.
func TestGoldenMatrix(t *testing.T) {
	f := loadVectors(t)
	if len(f.Vectors) < 2000 {
		t.Fatalf("only %d vectors; the generator's matrix shrank", len(f.Vectors))
	}
	contexts := map[string]bool{}
	holds := map[string]bool{}
	reasons := map[string]bool{}
	hosts := map[string]bool{}
	ats := map[string]bool{}
	anonymous := false
	for _, v := range f.Vectors {
		contexts[v.Context] = true
		holds[v.Context+"/"+v.Want.RegionHold] = true
		reasons[v.Context+"/"+v.Want.Reason] = true
		if v.Host == nil {
			hosts["<none>"] = true
		} else {
			hosts[*v.Host] = true
		}
		ats[v.At] = true
		anonymous = anonymous || v.User == nil
	}
	for _, c := range ContextNames {
		if !contexts[c] {
			t.Errorf("no vector for context %s", c)
		}
	}
	for _, want := range []string{
		"registry-subscription/none", "registry-subscription/restricted", "registry-subscription/blocked",
		"site/none", "site/restricted", "site/blocked", "public-api/none", "public-api/restricted", "public-api/blocked",
	} {
		if !holds[want] {
			t.Errorf("no vector with hold %s", want)
		}
	}
	for _, want := range []string{
		"registry-subscription/unknown-country", "registry-subscription/anonymous", "registry-subscription/user-settings",
		"site/moderator-bypass", "site/host-sfw", "site/anonymous", "site/user-settings", "public-api/unrestricted",
	} {
		if !reasons[want] {
			t.Errorf("no vector with reason %s", want)
		}
	}
	for _, h := range []string{"<none>", "green", "blue", "red", "other"} {
		if !hosts[h] {
			t.Errorf("no vector with host %s", h)
		}
	}
	// The end-of-date boundary of a dated rule, from both sides.
	for _, at := range []string{"2025-08-01T23:59:59.998Z", "2025-08-01T23:59:59.999Z", "2026-03-15T00:00:00.000Z", "2026-03-16T00:00:00.000Z"} {
		if !ats[at] {
			t.Errorf("no vector at %s", at)
		}
	}
	if !anonymous || len(f.Users) < 50 {
		t.Errorf("the user dimension shrank: anonymous=%v users=%d", anonymous, len(f.Users))
	}
}
