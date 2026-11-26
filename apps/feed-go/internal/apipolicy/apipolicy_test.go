package apipolicy

import "testing"

// The embedded file decodes into the facts the route reads; the literals are the Node modules' values
// (scripts/__tests__/feed-go-api-policy.schema-drift.test.ts pins the file to them).
func TestEmbeddedPolicy(t *testing.T) {
	if got := PrivateCacheControl(); got != "max-age=0, private, no-cache" {
		t.Fatalf("PrivateCacheControl = %q", got)
	}
	want451 := RegionBlockAnswer{
		Status:      451,
		ContentType: "application/json",
		Body:        `{"error":"Access to this service is not available in your region due to legal restrictions.","code":"REGION_BLOCKED"}`,
	}
	if got := RegionBlockResponse(); got != want451 {
		t.Fatalf("RegionBlockResponse = %+v, want %+v", got, want451)
	}
	found := false
	for _, b := range RegionBlockDefault() {
		if b == (RegionBlock{Region: "GB", EffectiveDate: "2025-07-24"}) {
			found = true
		}
	}
	if !found {
		t.Fatalf("RegionBlockDefault = %v, want GB:2025-07-24 in it", RegionBlockDefault())
	}
	for ua, want := range map[string]bool{
		"Googlebot/2.1": true,
		"Mozilla/5.0 (compatible; BingPreview/1.0b)": true,
		"Storebot-Google/1.0":                        true,
		"Mozilla/5.0 Firefox/130.0":                  false,
		"":                                           false,
	} {
		if got := IsCrawlerUserAgent(ua); got != want {
			t.Errorf("IsCrawlerUserAgent(%q) = %v, want %v", ua, got, want)
		}
	}
}
