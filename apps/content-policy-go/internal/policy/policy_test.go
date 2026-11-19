package policy

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

func sp(s string) *string { return &s }

var at0 = time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)

func mustRules(t *testing.T, env string) []Rule {
	t.Helper()
	r, err := ParseRules(env, nil)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestParseRules(t *testing.T) {
	got := mustRules(t, " fr:2025-08-01 ,US:NY:2025-07-24,\u00a0us:tx:2025-01-01\ufeff")
	want := []struct{ region, date string }{{"FR", "2025-08-01"}, {"US:NY", "2025-07-24"}, {"US:TX", "2025-01-01"}}
	if len(got) != len(want) {
		t.Fatalf("got %d rules, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i].Region != w.region || got[i].Date != w.date {
			t.Errorf("rule %d = %s:%s, want %s:%s", i, got[i].Region, got[i].Date, w.region, w.date)
		}
	}
	// The end of the day, UTC, to the millisecond.
	if want := time.Date(2025, 8, 1, 23, 59, 59, 999_000_000, time.UTC); !got[0].From.Equal(want) {
		t.Errorf("FR applies from %v, want %v", got[0].From, want)
	}
}

func TestParseRulesDefaults(t *testing.T) {
	defaults := []RuleSpec{{Region: "GB", EffectiveDate: "2025-07-24"}}
	got, err := ParseRules("", defaults)
	if err != nil || len(got) != 1 || got[0].Region != "GB" {
		t.Fatalf("an empty variable must be the defaults, got %+v, %v", got, err)
	}
	if _, err := ParseRules("", []RuleSpec{{Region: "GB", EffectiveDate: "July"}}); err == nil {
		t.Fatal("a default with a bad date must be an error")
	}
	// The block list's default is the site's (policydata.json, generated from region-blocking.ts).
	if b := RegionBlockDefault(); len(b) == 0 || b[0] != (RuleSpec{Region: "GB", EffectiveDate: "2025-07-24"}) {
		t.Fatalf("RegionBlockDefault() = %+v", b)
	}
	if r := RegionRestrictionDefault(); len(r) != 0 {
		t.Fatalf("RegionRestrictionDefault() = %+v, want the site's empty default", r)
	}
}

func TestParseRulesErrors(t *testing.T) {
	for _, env := range []string{
		"FR",                    // no colon
		"FR:2025-08-01,",        // an empty entry has no colon either (the site throws on it)
		"FR:2025-02-30",         // not a real date: the site's new Date rolls it to March 2
		"FR:2025-8-1",           // not zero-padded
		"FR:2025-08-01T00:00Z",  // not a date alone
		"FR:2025-08-01,GB:soon", // one bad entry fails the list
	} {
		if _, err := ParseRules(env, nil); err == nil {
			t.Errorf("ParseRules(%q) accepted it", env)
		}
	}
}

func TestJSString(t *testing.T) {
	for in, want := range map[string]string{
		"\u00a0GB\ufeff": "GB", "\u2000GB\u200a": "GB", "\u3000GB\u2028": "GB",
		"\u0085GB": "\u0085GB", "\t\nGB\r": "GB", // NEL: strings.TrimSpace strips it, JS does not
	} {
		if got := jsTrim(in); got != want {
			t.Errorf("jsTrim(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{"gb": "GB", "us:ny": "US:NY", "\u00df": "SS", "\u017fe": "SE", "\ufb00": "FF"} {
		if got := jsUpper(in); got != want {
			t.Errorf("jsUpper(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCountryKnown(t *testing.T) {
	known := func(country *string, isUK *string) bool {
		return countryKnown(resolve(Location{Country: country, IsUK: isUK}))
	}
	for _, c := range []string{"GB", "gb", " fr ", "ZZ", "\u00df"} {
		if !known(sp(c), nil) {
			t.Errorf("%q must be a known country", c)
		}
	}
	for _, c := range []string{"", "XX", "xx", "T1", "USA", "G", "1A", "\u0085FR", "GB,FR"} {
		if known(sp(c), nil) {
			t.Errorf("%q must not be a known country", c)
		}
	}
	if known(nil, nil) {
		t.Error("no country header must not be a known country")
	}
	if !known(nil, sp("1")) {
		t.Error("x-isuk 1 makes the country GB")
	}
}

func TestMatches(t *testing.T) {
	rules := mustRules(t, "US:2025-06-01,US:NY:2025-07-24,FR:2025-08-01")
	m := func(country, region *string) bool {
		return matches(rules, resolve(Location{Country: country, Region: region}), at0)
	}
	cases := []struct {
		country, region *string
		want            bool
	}{
		{sp("FR"), nil, true},
		{sp("fr"), nil, true},
		{sp(" FR"), nil, false}, // the lists are read untrimmed
		{sp("US"), sp("NY"), true},
		{sp("US"), sp("ny"), true},
		{sp("US"), sp("CA"), false}, // a US state is judged by its own entry, not the country's
		{sp("US"), nil, true},
		{sp("US"), sp(""), true},
		{sp("us"), sp("CA"), true}, // `us` is not `US`: judged by the country alone
		{sp(""), nil, false},
		{nil, nil, false},
	}
	for _, c := range cases {
		if got := m(c.country, c.region); got != c.want {
			t.Errorf("matches(%s, %s) = %v, want %v", str(c.country), str(c.region), got, c.want)
		}
	}
	// The first entry naming the region decides, even when a later one would apply sooner.
	first := mustRules(t, "FR:2030-01-01,FR:2020-01-01")
	if matches(first, resolve(Location{Country: sp("FR")}), at0) {
		t.Error("the first FR entry (2030) must decide")
	}
}

func TestDatedRuleBoundary(t *testing.T) {
	rules := mustRules(t, "FR:2025-08-01")
	info := resolve(Location{Country: sp("FR")})
	for _, c := range []struct {
		at   time.Time
		want bool
	}{
		{time.Date(2025, 8, 1, 0, 0, 0, 0, time.UTC), false},
		{time.Date(2025, 8, 1, 23, 59, 59, 998_000_000, time.UTC), false},
		{time.Date(2025, 8, 1, 23, 59, 59, 999_000_000, time.UTC), true},
		{time.Date(2025, 8, 2, 0, 0, 0, 0, time.UTC), true},
	} {
		if got := matches(rules, info, c.at); got != c.want {
			t.Errorf("FR:2025-08-01 at %v = %v, want %v", c.at, got, c.want)
		}
	}
}

// TestSFW pins the fail-closed decision as literals: every error and malformed request is answered
// with it.
func TestSFW(t *testing.T) {
	got := SFW(ReasonError)
	if !slices.Equal(got.Ratings, []string{"g", "pg", "pg13"}) || got.UnknownRating || got.BrowsingLevel != 1 ||
		got.RegionHold != HoldRestricted || got.Reason != "error" {
		t.Fatalf("SFW(error) = %+v, want ratings [g pg pg13], no unknown rating, level 1 (PG), held, reason error", got)
	}
}

func TestDecideUnknownContext(t *testing.T) {
	e := NewEngine(nil, nil)
	got, err := e.Decide(Input{Context: "feed", Location: Location{Country: sp("NL")}, At: at0})
	if !errors.Is(err, ErrUnknownContext) {
		t.Fatalf("err = %v, want ErrUnknownContext", err)
	}
	if got.Reason != ReasonInvalidInput || slices.Contains(got.Ratings, "r") || got.BrowsingLevel != 1 {
		t.Fatalf("an unknown context must answer the SFW decision, got %+v", got)
	}
}

// A user id with no usable user is decided as anonymous, in every context that reads the user.
func TestDecideUnavailableIsAnonymous(t *testing.T) {
	e := NewEngine(nil, nil)
	for _, c := range []string{ContextRegistrySubscription, ContextSite} {
		in := Input{Context: c, Location: Location{Country: sp("NL")}, Host: "red", At: at0,
			Viewer: Unavailable, User: User{ShowNsfw: true, BrowsingLevel: 31, IsModerator: true}}
		got, err := e.Decide(in)
		if err != nil {
			t.Fatal(err)
		}
		in.Viewer, in.User = Anonymous, User{}
		anon, _ := e.Decide(in)
		if !slices.Equal(got.Ratings, anon.Ratings) || got.BrowsingLevel != anon.BrowsingLevel || got.UnknownRating != anon.UnknownRating {
			t.Errorf("%s: unavailable %+v differs from anonymous %+v", c, got, anon)
		}
		if got.Reason != ReasonUserUnavailable {
			t.Errorf("%s: reason %q, want %q", c, got.Reason, ReasonUserUnavailable)
		}
	}
}

// The registry holds a request whose country cannot be told to SFW: a full mature user gets no
// mature rating and no unknown rating.
func TestRegistryUnknownCountryHolds(t *testing.T) {
	e := NewEngine(nil, nil)
	for _, country := range []*string{nil, sp(""), sp("XX"), sp("T1"), sp("USA")} {
		got, _ := e.Decide(Input{Context: ContextRegistrySubscription, Location: Location{Country: country}, At: at0,
			Viewer: SignedIn, User: User{ShowNsfw: true, BrowsingLevel: 31}})
		if got.RegionHold != HoldRestricted || got.Reason != ReasonUnknownCountry ||
			!slices.Equal(got.Ratings, []string{"g", "pg", "pg13"}) || got.UnknownRating {
			t.Errorf("country %s: %+v, want held to SFW for unknown-country", str(country), got)
		}
	}
}

// Each rating maps to its own level bit: a user whose level carries only one mature bit gets only
// that rating (the site context, which reads xxx by its own bit).
func TestRatingsMapToTheirOwnBits(t *testing.T) {
	e := NewEngine(nil, nil)
	for level, want := range map[int32][]string{
		4:  {"g", "pg", "pg13", "r"},
		8:  {"g", "pg", "pg13", "x"},
		16: {"g", "pg", "pg13", "xxx"},
		1:  {"g", "pg", "pg13"},
	} {
		got, _ := e.Decide(Input{Context: ContextSite, Location: Location{Country: sp("NL")}, Host: "red", At: at0,
			Viewer: SignedIn, User: User{ShowNsfw: true, BrowsingLevel: level}})
		if !slices.Equal(got.Ratings, want) {
			t.Errorf("site level %d: ratings %v, want %v", level, got.Ratings, want)
		}
	}
}

func TestPolicyVersion(t *testing.T) {
	a := NewEngine(mustRules(t, "FR:2025-08-01"), nil).PolicyVersion()
	b := NewEngine(mustRules(t, "FR:2025-08-02"), nil).PolicyVersion()
	c := NewEngine(mustRules(t, "FR:2025-08-01"), nil).PolicyVersion()
	if len(a) != 12 || a == b || a != c {
		t.Fatalf("versions %q %q %q: want 12 hex chars, changing with the lists and stable otherwise", a, b, c)
	}
}

func TestParseData(t *testing.T) {
	var d policyData
	if err := parseData(dataJSON, &d); err != nil {
		t.Fatalf("the embedded file must parse: %v", err)
	}
	for _, bad := range []string{
		`{`,
		`{"levels":{}}`,
		`{"levels":{"pg":1,"pg13":2,"r":4,"x":8,"xxx":16,"blocked":32,"public":1,"sfw":3,"all":31}}`,
		`{"levels":{"pg":1,"pg13":2,"r":4,"x":8,"xxx":16,"blocked":32,"public":1,"sfw":3,"all":31},` +
			`"ratingLadder":["g","xxx"],"matureRatings":["r"],"noCountryCodes":["XX"]}`,
	} {
		if err := parseData([]byte(bad), &policyData{}); err == nil {
			t.Errorf("parseData(%s) accepted it", bad)
		}
	}
	if !slices.Equal(Ratings, []string{"g", "pg", "pg13", "r", "x", "xxx"}) {
		t.Fatalf("Ratings = %v", Ratings)
	}
}

func TestReadsUser(t *testing.T) {
	if !ReadsUser(ContextRegistrySubscription) || !ReadsUser(ContextSite) || ReadsUser(ContextPublicAPI) || ReadsUser("nope") {
		t.Fatal("only the viewer-level contexts read the user")
	}
	for _, c := range ContextNames {
		if _, ok := Contexts[c]; !ok {
			t.Errorf("ContextNames lists %q, which Contexts does not define", c)
		}
	}
	if len(ContextNames) != len(Contexts) {
		t.Errorf("ContextNames has %d entries, Contexts %d", len(ContextNames), len(Contexts))
	}
}

func FuzzDecide(f *testing.F) {
	f.Add("registry-subscription", "GB", "", "", "red", true, int32(31), false, int64(0))
	f.Add("site", "us", "ny", "1", "", false, int32(-1), true, int64(1))
	f.Add("public-api", "\u00a0FR", "", "true", "other", true, int32(63), false, int64(-1))
	e := NewEngine(mustRulesF(f, "FR:2025-08-01,US:NY:2025-07-24"), mustRulesF(f, "GB:2025-07-24"))
	f.Fuzz(func(t *testing.T, ctx, country, region, isUK, host string, signedIn bool, level int32, mod bool, offset int64) {
		in := Input{Context: ctx, Location: Location{Country: &country, Region: &region, IsUK: &isUK}, Host: host,
			At: at0.Add(time.Duration(offset % int64(400*24*time.Hour)))}
		if signedIn {
			in.Viewer, in.User = SignedIn, User{ShowNsfw: true, BrowsingLevel: level, IsModerator: mod}
		}
		got, err := e.Decide(in)
		if err != nil {
			if !errors.Is(err, ErrUnknownContext) {
				t.Fatalf("unexpected error %v", err)
			}
			return
		}
		if !slices.Contains(Holds, got.RegionHold) || !slices.Contains(Reasons, got.Reason) {
			t.Fatalf("hold %q / reason %q not in the label sets", got.RegionHold, got.Reason)
		}
		for _, r := range got.Ratings {
			if !slices.Contains(Ratings, r) {
				t.Fatalf("rating %q is not one of Ratings", r)
			}
		}
		// A held decision never carries a mature rating in the registry (the SFW domain's rule).
		if ctx == ContextRegistrySubscription && got.RegionHold != HoldNone &&
			(slices.Contains(got.Ratings, "r") || slices.Contains(got.Ratings, "x") || got.UnknownRating) {
			t.Fatalf("held registry decision %+v carries a mature rating", got)
		}
		if strings.TrimSpace(got.Reason) == "" {
			t.Fatal("empty reason")
		}
	})
}

func mustRulesF(f *testing.F, env string) []Rule {
	r, err := ParseRules(env, nil)
	if err != nil {
		f.Fatal(err)
	}
	return r
}
