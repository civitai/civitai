package browsing

import (
	"reflect"
	"testing"
	"time"
)

func TestDomainCapAndClamp(t *testing.T) {
	// Signed out: everything is held to PG, and a request with nothing in common becomes PG.
	cap := DomainCap(false, true)
	if cap != 1 {
		t.Fatalf("signed-out cap = %d, want 1", cap)
	}
	if got := ClampToCap(28, cap); got != 1 { // R|X|XXX & PG = 0 -> cap
		t.Fatalf("clamp(28,1) = %d, want 1", got)
	}
	// Signed in on a SFW domain: PG|PG13.
	if got := ClampToCap(31, DomainCap(true, false)); got != 3 {
		t.Fatalf("clamp(31,3) = %d, want 3", got)
	}
	// Signed in where NSFW is viewable: no cap, the request stands.
	if got := ClampToCap(12, DomainCap(true, true)); got != 12 {
		t.Fatalf("uncapped clamp = %d, want 12", got)
	}
	// Unset request under a cap is the cap.
	if got := ClampToCap(0, 3); got != 3 {
		t.Fatalf("clamp(0,3) = %d, want 3", got)
	}
}

func TestResolveDefaultAddons(t *testing.T) {
	// PG only: the "none of X/XXX" entry applies (no fields), the "some of all levels" applies
	// (disablePoi + people tags), the "some of R/X/XXX" does not.
	r := ResolveAddons(DefaultAddons, PG, false, "")
	if !r.DisablePoi || r.DisableMinor {
		t.Fatalf("PG: poi=%v minor=%v, want true,false", r.DisablePoi, r.DisableMinor)
	}
	if !reflect.DeepEqual(r.ExcludedTagIDs, peopleTagIDs) {
		t.Fatalf("PG excluded = %v", r.ExcludedTagIDs)
	}
	// R: both "some" entries apply, tags accumulate in entry order.
	r = ResolveAddons(DefaultAddons, R|PG, false, "")
	if !r.DisablePoi || !r.DisableMinor {
		t.Fatalf("R: poi=%v minor=%v, want true,true", r.DisablePoi, r.DisableMinor)
	}
	want := append(append([]int{}, peopleTagIDs...), childTagIDs...)
	if !reflect.DeepEqual(r.ExcludedTagIDs, want) {
		t.Fatalf("R excluded = %v, want %v", r.ExcludedTagIDs, want)
	}
	// Moderators resolve to nothing.
	if r := ResolveAddons(DefaultAddons, AllLevels, true, ""); r.DisablePoi || r.DisableMinor || len(r.ExcludedTagIDs) != 0 {
		t.Fatalf("moderator resolved %+v", r)
	}
}

func TestResolveAddonsScopeAndAll(t *testing.T) {
	addons := []Addon{
		{Type: "all", NsfwLevels: []int{PG, PG13}, ExcludedTagIDs: []int{1}},
		{Type: "some", NsfwLevels: []int{PG}, Scope: "newCreators", ExcludedTagIDs: []int{2}},
		{Type: "some", NsfwLevels: []int{PG}, Scope: "typo", ExcludedTagIDs: []int{3}},
		{Type: "some", NsfwLevels: []int{PG}, DisablePoi: ptr(true)},
		{Type: "some", NsfwLevels: []int{PG}, DisablePoi: ptr(false)},  // last explicit wins
		{Type: "some", NsfwLevels: []int{6}, ExcludedTagIDs: []int{4}}, // 6 is not a power of two: ignored
	}
	r := ResolveAddons(addons, PG|PG13, false, "newCreators")
	if !reflect.DeepEqual(r.ExcludedTagIDs, []int{1, 2}) || r.DisablePoi {
		t.Fatalf("got %+v", r)
	}
	r = ResolveAddons(addons, PG, false, "")
	if len(r.ExcludedTagIDs) != 0 {
		t.Fatalf("PG only should miss the 'all' entry and the scoped one, got %v", r.ExcludedTagIDs)
	}
}

func TestHostColorsAndCanViewNsfw(t *testing.T) {
	h := HostColors{"green": {"green.example"}, "blue": {"blue.example", "alias.example"}, "red": {"red.example"}}
	cases := map[string]string{"Blue.Example:443": "blue", "alias.example": "blue", "green.example": "green", "red.example": "red", "other": ""}
	for host, want := range cases {
		if got := h.ColorOf(host); got != want {
			t.Errorf("ColorOf(%q) = %q, want %q", host, got, want)
		}
	}
	if CanViewNsfw("green", false, false) || CanViewNsfw("", false, true) {
		t.Fatal("green/unknown hosts must not view NSFW")
	}
	if !CanViewNsfw("red", false, false) || CanViewNsfw("blue", true, false) || !CanViewNsfw("blue", true, true) {
		t.Fatal("region gate wrong")
	}
}

func TestRegionRestricted(t *testing.T) {
	eff := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rules := []RegionRule{{Region: "US:TX", Effective: eff}, {Region: "DE", Effective: eff}}
	before, after := eff.Add(-time.Hour), eff.Add(time.Hour)
	if IsRegionRestricted(rules, "DE", "", before) || !IsRegionRestricted(rules, "de", "", after) {
		t.Fatal("country rule by date wrong")
	}
	if !IsRegionRestricted(rules, "US", "tx", after) || IsRegionRestricted(rules, "US", "CA", after) || IsRegionRestricted(rules, "US", "", after) {
		t.Fatal("US state rule wrong")
	}
	if IsRegionRestricted(rules, "", "", after) {
		t.Fatal("no country header must not restrict")
	}
}

// getRequestBoardDomainColor: a host on red's list is red, whatever else lists it; an alias of a color
// whose primary is on red's list is red too (a blue alias of the red-primary blue site); otherwise the
// walked color, and "" for an unknown host.
func TestBoardColorOf(t *testing.T) {
	h := HostColors{
		"green": {"green.example.test"},
		"blue":  {"red.example.test", "blue-alias.example.test"},
		"red":   {"red.example.test"},
	}
	primaries := map[string]string{"green": "green.example.test", "blue": "red.example.test", "red": "red.example.test"}
	for host, want := range map[string]string{
		"red.example.test":        "red",
		"RED.example.test":        "red",
		"blue-alias.example.test": "red",
		"green.example.test":      "green",
		"unknown.example.test":    "",
		"":                        "",
	} {
		if got := h.BoardColorOf(host, primaries); got != want {
			t.Errorf("BoardColorOf(%q) = %q, want %q", host, got, want)
		}
	}
	// ColorOf walks green, blue, red: the red host reads blue there, which is why the board color exists.
	if got := h.ColorOf("red.example.test"); got != "blue" {
		t.Fatalf("control: ColorOf(red host) = %q, want blue", got)
	}
	// A blue site whose primary is its own SFW host: its alias stays blue, and so it does without
	// primaries at all.
	h2 := HostColors{"blue": {"blue.example.test", "blue-alias.example.test"}, "red": {"red.example.test"}}
	sfw := map[string]string{"blue": "blue.example.test", "red": "red.example.test"}
	if got := h2.BoardColorOf("blue-alias.example.test", sfw); got != "blue" {
		t.Fatalf("an SFW blue primary: alias reads %q, want blue", got)
	}
	if got := h2.BoardColorOf("blue-alias.example.test", nil); got != "blue" {
		t.Fatalf("no primaries: alias reads %q, want blue", got)
	}
}
