package auth

import "testing"

// AnyQueryToken is requestCarriesQueryToken: any non-empty `token` value, under the URLSearchParams
// reading or Go's. HasQueryTokenRaw is hasQueryToken's (the first value), and AnyQueryToken reports
// every query it does.
func TestAnyQueryToken(t *testing.T) {
	for _, c := range []struct {
		raw       string
		any, head bool
	}{
		{"", false, false},
		{"token=", false, false},
		{"tokens=k", false, false},
		{"token=k", true, true},
		{"%74oken=k", true, true},
		// Go's url.ParseQuery drops these pairs; URLSearchParams keeps them.
		{"token=abc%zz", true, true},
		{"token=a;b", true, true},
		// The first value is empty: no bearer token (readRequestBearerToken), but a credential to the
		// wrappers (`req.query.token` holds a non-empty value).
		{"token=&token=x", true, false},
		{"a=1;token=k", false, false},
	} {
		if got := AnyQueryToken(c.raw); got != c.any {
			t.Errorf("AnyQueryToken(%q) = %v, want %v", c.raw, got, c.any)
		}
		if got := HasQueryTokenRaw(c.raw); got != c.head {
			t.Errorf("HasQueryTokenRaw(%q) = %v, want %v", c.raw, got, c.head)
		}
		if HasQueryTokenRaw(c.raw) && !AnyQueryToken(c.raw) {
			t.Errorf("%q: HasQueryTokenRaw reports it and AnyQueryToken does not", c.raw)
		}
	}
}
