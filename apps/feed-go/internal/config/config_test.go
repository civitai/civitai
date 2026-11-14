package config

import (
	"reflect"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
)

func TestParseRegionRulesEndOfDay(t *testing.T) {
	rules, err := ParseRegionRules("gb:2026-03-15, US:TX:2026-04-02")
	if err != nil {
		t.Fatal(err)
	}
	want := []browsing.RegionRule{
		{Region: "GB", Effective: time.Date(2026, 3, 15, 23, 59, 59, int(999*time.Millisecond), time.UTC)},
		{Region: "US:TX", Effective: time.Date(2026, 4, 2, 23, 59, 59, int(999*time.Millisecond), time.UTC)},
	}
	if !reflect.DeepEqual(rules, want) {
		t.Fatalf("rules = %+v, want %+v", rules, want)
	}
	// Mid-day on the effective date is NOT yet restricted (Node: `${date}T23:59:59.999Z`).
	midday := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	if browsing.IsRegionRestricted(rules, "GB", "", midday) {
		t.Fatal("restricted before the end of the effective day")
	}
	if !browsing.IsRegionRestricted(rules, "GB", "", time.Date(2026, 3, 16, 0, 0, 0, 0, time.UTC)) {
		t.Fatal("not restricted after the effective day")
	}
	if _, err := ParseRegionRules("GB"); err == nil {
		t.Fatal("an entry without a date must fail")
	}
}

func TestHostFromURL(t *testing.T) {
	cases := map[string]string{
		"https://Civitai.Example":         "civitai.example",
		"https://a.example:8443/path?q=1": "a.example:8443",
		"https://a.example:443":           "a.example",
		"http://b.example:80":             "b.example",
		"http://b.example:8080":           "b.example:8080",
		"":                                "",
		"not a url":                       "",
		"a.example":                       "",
		"//no-scheme.example":             "",
	}
	for in, want := range cases {
		if got := HostFromURL(in); got != want {
			t.Errorf("HostFromURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAllowedOriginHosts(t *testing.T) {
	hosts := browsing.HostColors{"green": {"Green.Example", "alias.green.example"}, "blue": {"blue.example"}, "red": nil}
	got := AllowedOriginHosts(hosts, []string{"https://studio.example", "junk"}, "https://auth-callback.example")
	want := map[string]bool{
		"green.example": true, "alias.green.example": true, "blue.example": true,
		"studio.example": true, "auth-callback.example": true,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestLoadModerationAccountID(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "REDIS_URL", "REDIS_SYS_URL", "AUTH_JWKS_URI", "AUTH_JWT_ISSUER"} {
		t.Setenv(k, "x://"+k)
	}
	for in, want := range map[string]int{"9131": 9131, "": 0, "-4": 0, "abc": 0} {
		t.Setenv("CIVITAI_MODERATION_USER_ID", in)
		c, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if c.ModerationAccountID != want {
			t.Errorf("CIVITAI_MODERATION_USER_ID=%q -> %d, want %d", in, c.ModerationAccountID, want)
		}
	}
}
