package sign

import (
	"net/http"
	"testing"
)

// ReadRegion: each region header one well-formed value or absent; a repeated or malformed one names
// itself and yields no region at all.
func TestReadRegion(t *testing.T) {
	cases := []struct {
		h    map[string][]string
		want [3]string
		bad  string
	}{
		{map[string][]string{}, [3]string{}, ""},
		{map[string][]string{"Cf-Ipcountry": {"US"}, "Cf-Region-Code": {"CA"}, "X-Isuk": {"0"}}, [3]string{"US", "CA", "0"}, ""},
		{map[string][]string{"Cf-Ipcountry": {"GB"}}, [3]string{"GB", "", ""}, ""},
		{map[string][]string{"Cf-Ipcountry": {"FR", "US"}}, [3]string{}, "cf-ipcountry"},
		{map[string][]string{"Cf-Ipcountry": {"US"}, "Cf-Region-Code": {"N Y"}}, [3]string{}, "cf-region-code"},
		{map[string][]string{"X-Isuk": {""}}, [3]string{}, "x-isuk"},
		{map[string][]string{"Cf-Ipcountry": {"ABCDEFGHIJKLMNOPQ"}}, [3]string{}, "cf-ipcountry"},
	}
	for _, c := range cases {
		got, bad := ReadRegion(http.Header(c.h))
		if got != c.want || bad != c.bad {
			t.Errorf("%v: %v %q; want %v %q", c.h, got, bad, c.want, c.bad)
		}
	}
}
