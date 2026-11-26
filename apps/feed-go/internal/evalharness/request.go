package evalharness

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
	"github.com/civitai/civitai/apps/feed-go/internal/server"
)

// procedures is each tRPC endpoint's procedure path; an endpoint not here is REST (its stored path).
var procedures = map[string]string{
	evalcorpus.EndpointAsPosts:     server.Procedure,
	evalcorpus.EndpointInfinite:    server.ProcedureInfinite,
	evalcorpus.EndpointModelGetAll: server.ProcedureModelGetAll,
}

// Prepared is one case's request, sent the same to Node (with server.ParityReplayHeader) and to Go.
type Prepared struct {
	Path, RawQuery string
	// Host is the stored Host header (the request's Host).
	Host string
	// Header is every other header: the stored ones (cf-*, x-isuk, the verified-crawler marker,
	// origin), a same-site Referer, and the credentials.
	Header http.Header
}

// Prepare builds c's request for creds, or the not_replayable reason. The tRPC input and the REST
// query get their placeholders replaced before anything decodes them.
func Prepare(c Case, creds Credentials) (*Prepared, string) {
	if !evalcapture.Supported(c.Endpoint) {
		return nil, "endpoint"
	}
	req := c.Request
	p := &Prepared{Header: http.Header{}}
	if proc, ok := procedures[c.Endpoint]; ok {
		if req.Input == "" && strings.Contains(c.SigText, `"$envelope":"invalid"`) {
			// The input did not decode at capture, so it was not stored: replaying none would be
			// another request.
			return nil, "input-not-stored"
		}
		p.Path = "/api/trpc/" + proc
		if req.Input != "" {
			in, err := SubstituteInput(req.Input, creds.Identity)
			if err != nil {
				return nil, placeholderReason(err)
			}
			p.RawQuery = url.Values{"input": {in}}.Encode()
		}
	} else {
		if req.Path == "" {
			return nil, "path-not-stored"
		}
		p.Path = req.Path
		q, err := SubstituteQuery(req.Query, creds.Identity)
		if err != nil {
			return nil, placeholderReason(err)
		}
		p.RawQuery = q
	}
	if creds.QueryToken != "" {
		pair := "token=" + url.QueryEscape(creds.QueryToken)
		if p.RawQuery == "" {
			p.RawQuery = pair
		} else {
			p.RawQuery += "&" + pair
		}
	}
	p.Host = caseHost(req)
	for k, v := range req.Headers {
		if !strings.EqualFold(k, "host") {
			p.Header.Set(k, v)
		}
	}
	if p.Host != "" {
		p.Header.Set("Referer", "https://"+p.Host+"/")
	}
	if creds.Cookie != "" {
		p.Header.Set("Cookie", creds.Cookie)
	}
	if creds.Bearer != "" {
		p.Header.Set("Authorization", "Bearer "+creds.Bearer)
	}
	return p, ""
}

// caseHost is a stored request's Host header ("": none stored): the host a case is replayed to, and
// so the site whose session token replays it (Accounts.Resolve).
func caseHost(req evalcapture.StoredRequest) string {
	for k, v := range req.Headers {
		if strings.EqualFold(k, "host") {
			return v
		}
	}
	return ""
}

func placeholderReason(err error) string {
	if errors.Is(err, ErrPlaceholder) {
		return "placeholder-unfilled"
	}
	return "input-invalid"
}

// isTRPC: the endpoint's answer is a tRPC envelope.
func isTRPC(endpoint string) bool {
	_, ok := procedures[endpoint]
	return ok
}
