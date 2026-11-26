package modelfeed

import (
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// The inputs getPersonalLeadIdsForFeed shapes (Hot, any page) and each one that turns it off.
func TestPersonalHotLeadEligible(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"json":{"sort":"Hot","browsingLevel":3}}`:                                   true,
		`{"json":{"sort":"Hot","period":"Week","baseModels":["SDXL 1.0"],"limit":7}}`: true, // other filters keep it
		`{"json":{"sort":"Hot","username":"!!!"}}`:                                    true, // slugifies to nothing
		`{"json":{"sort":"Hot","favorites":false,"archived":false,"collectionId":0}}`: true,
		`{"json":{"sort":"Hot","cursor":""}}`:                                         true,
		`{"json":{"sort":"Hot","cursor":"812|7301"}}`:                                 true, // later pages drop the lead ids
		`{"json":{"sort":"Newest"}}`:                                                  false,
		`{"json":{}}`:                                                                 false, // the schema default is Highest Rated
		`{"json":{"sort":"Hot","username":"creator_nine"}}`:                           false,
		`{"json":{"sort":"Hot","user":"creator_ten"}}`:                                false,
		`{"json":{"sort":"Hot","collectionId":6203}}`:                                 false,
		`{"json":{"sort":"Hot","favorites":true}}`:                                    false,
		`{"json":{"sort":"Hot","favorites":"true"}}`:                                  false, // booleanString
		`{"json":{"sort":"Hot","archived":true}}`:                                     false,
	} {
		in, err := parseJSON(t, raw)
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if got := in.PersonalHotLeadEligible(); got != want {
			t.Errorf("%s: eligible %v, want %v", raw, got, want)
		}
	}
}

// `favorites` is a booleanString, as `archived`: a value the schema rejects is input-invalid.
func TestParseFavorites(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"json":{"favorites":true}}`:    true,
		`{"json":{"favorites":"yes"}}`:   true,
		`{"json":{"favorites":"false"}}`: false,
		`{"json":{"favorites":null}}`:    false,
		`{"json":{}}`:                    false,
	} {
		in, err := parseJSON(t, raw)
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if in.Favorites != want {
			t.Errorf("%s: Favorites %v, want %v", raw, in.Favorites, want)
		}
	}
	if _, err := parseJSON(t, `{"json":{"favorites":"maybe"}}`); fallback.Reason(err) != "input-invalid" {
		t.Fatalf("favorites maybe: %v, want input-invalid", err)
	}
}
