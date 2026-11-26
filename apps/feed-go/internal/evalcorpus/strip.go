package evalcorpus

import (
	"net/http"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// keptHeaders is every header a Case keeps: the ones the endpoints' answers depend on besides the
// credentials (the domain, the region, the verified-crawler marker the edge sets, the CORS origin).
// It is an allow-list on purpose: a header not named here (Cookie, Authorization, the sampler's
// credential header, the client address headers, User-Agent, Referer, anything new) is never stored.
var keptHeaders = []string{"host", "cf-ipcountry", "cf-region-code", "x-isuk", "x-civitai-verified-bot", "origin"}

// SampleCredentialHeader is the header the Node sampler sends a credential's description in
// (server.SampleCredentialHeader): it stands for an Authorization header.
const SampleCredentialHeader = "x-feed-go-credential" //nolint:gosec // G101: a header name, not a credential

// Credential classes. A request carrying several is the classes joined with "+", in this order.
const (
	CredentialNone    = "none"
	CredentialHeader  = "header"  // an Authorization header (or the sampler's description of one)
	CredentialQuery   = "query"   // a non-empty `token` query value (auth.AnyQueryToken)
	CredentialSession = "session" // a cookie under a session cookie name (v1models.HasSessionCookie)
)

// credentialWords mark a query pair or input key name as a credential's: such a pair or key is never
// stored, whatever the endpoint reads of it. Matched against the lowercased name.
var credentialWords = []string{
	"token", "secret", "password", "passwd", "cookie", "authorization", "bearer", "apikey", "api_key",
	"api-key", "credential", "session",
}

// isCredentialName reports whether a query or input key name holds a credential word.
func isCredentialName(name string) bool {
	l := strings.ToLower(name)
	for _, w := range credentialWords {
		if strings.Contains(l, w) {
			return true
		}
	}
	return false
}

// lowerHeaders is h with every name lowercased (values of names equal but for case joined with
// ", ", cookies with "; ", in sorted name order, so the result does not depend on map order).
func lowerHeaders(h map[string]string) map[string]string {
	out := make(map[string]string, len(h))
	for _, k := range sortedKeys(h) {
		l := strings.ToLower(strings.TrimSpace(k))
		if prev, ok := out[l]; ok && prev != "" {
			sep := ", "
			if l == "cookie" {
				sep = "; " // as Node joins several Cookie lines
			}
			out[l] = prev + sep + h[k]
			continue
		}
		out[l] = h[k]
	}
	return out
}

// keptHeaderValues is the keptHeaders entries of a lowercased header map.
func keptHeaderValues(h map[string]string) map[string]string {
	out := map[string]string{}
	for _, k := range keptHeaders {
		if v, ok := h[k]; ok {
			out[k] = v
		}
	}
	return out
}

// credentialClass is the class of what the request presents as a credential, read as the server
// reads it (v1models.CarriesCallerCredentials' three arms) plus the sampler's header.
func credentialClass(h map[string]string, rawQuery string) string {
	var classes []string
	if h["authorization"] != "" || h[SampleCredentialHeader] != "" {
		classes = append(classes, CredentialHeader)
	}
	if auth.AnyQueryToken(rawQuery) {
		classes = append(classes, CredentialQuery)
	}
	if c, ok := h["cookie"]; ok {
		hh := http.Header{}
		hh.Set("Cookie", c)
		if v1models.HasSessionCookie(hh) {
			classes = append(classes, CredentialSession)
		}
	}
	if len(classes) == 0 {
		return CredentialNone
	}
	return strings.Join(classes, "+")
}

// stripQuery is a raw query string without any pair whose (unescaped) name holds a credential word,
// the `token` credential among them, in its original order and encoding. dropped reports whether a
// pair went. A pair whose raw text holds `token` anywhere (`a=1;token=k`, an escaped name) is dropped
// too: what URLSearchParams would read as an ordinary value can still be a key someone pasted.
func stripQuery(raw string) (kept string, dropped bool) {
	pairs := splitQuery(raw)
	out := make([]string, 0, len(pairs))
	for _, p := range pairs {
		if isCredentialName(p.key) || isCredentialName(lenientUnescape(p.raw)) {
			dropped = true
			continue
		}
		out = append(out, p.raw)
	}
	return strings.Join(out, "&"), dropped
}
