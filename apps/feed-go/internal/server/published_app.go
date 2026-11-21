package server

import (
	"context"
	"net/http"

	"github.com/civitai/civitai/apps/feed-go/internal/appchip"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// ProcedurePublishedApp is the tRPC procedure shadowed at /internal/shadow/<it> (the image page's
// "Published with <app>" credit). Shadow only: no public route serves it (DESIGN.md §18).
const ProcedurePublishedApp = "image.getPublishedWithApp"

// EndpointPublishedApp is its feed_endpoint label.
const EndpointPublishedApp = "image-published-app"

// ShadowPublishedAppHandler is the internal compare endpoint for the tRPC procedure
// `image.getPublishedWithApp`.
func (s *Server) ShadowPublishedAppHandler(w http.ResponseWriter, r *http.Request) {
	s.shadowHandler(w, r, EndpointPublishedApp) //nolint:contextcheck // the sample is compared after the 202 is written, on the server's background context: it must outlive the request
}

// SyntheticPublishedAppRequest rebuilds the request an image-published-app sample describes.
func SyntheticPublishedAppRequest(ctx context.Context, req ShadowRequest) (*http.Request, error) {
	return syntheticTRPCRequest(ctx, req, ProcedurePublishedApp)
}

// publishedAppRoute is compare's dispatch for the procedure: the request rebuild, the compute and the
// classification (the superjson envelope of one value, `null` or a chip object, so a difference is
// `fields`).
func (s *Server) publishedAppRoute(endpoint string) (
	build func(context.Context, ShadowRequest) (*http.Request, error),
	compute func(context.Context, *http.Request) (*computed, error),
	classify func(*shadow.Report, []byte, []byte) string,
	ok bool,
) {
	if endpoint != EndpointPublishedApp {
		return nil, nil, nil, false
	}
	compute = s.computePublishedApp
	if s.computePublishedAppFn != nil {
		compute = s.computePublishedAppFn
	}
	return SyntheticPublishedAppRequest, compute, classifyValue, true
}

// classifyValue is Classify for an answer that is one value, not a page: match, else fields (the
// report's categories say where; a Go `null` against a Node chip is a `type` difference at the root).
func classifyValue(r *shadow.Report, _, _ []byte) string {
	if r.Match {
		return "match"
	}
	return "fields"
}

// computePublishedApp answers an `image.getPublishedWithApp` request (getImagePublishedWithAppHandler),
// or returns a fallback/other error. The answer is written through computed.encode, the format the app
// writes it in. Cache policy is createContext's: nothing in this procedure's chain changes it on a path
// served here (keepCrawlerAnswerOutOfEdgeCache runs only for a verified crawler, which falls back), so
// a signed-out answer carries the public TTL and a session's none.
func (s *Server) computePublishedApp(ctx context.Context, r *http.Request) (*computed, error) {
	req, signedOut, err := s.preparePublishedApp(ctx, r)
	if err != nil {
		return nil, err
	}
	ans, err := appchip.Serve(ctx, s.PublishedApp, req)
	if err != nil {
		return nil, err
	}
	out := &computed{value: ans.Value, trivial: ans.Trivial, viewerClass: ans.ViewerClass}
	if signedOut {
		out.ttl = &trpc.SignedOutTTL
	}
	if err := out.encode(context.Background()); err != nil {
		return nil, err
	}
	return out, nil
}

// preparePublishedApp is computePublishedApp up to the handler call, and whether there is no session
// user at all.
func (s *Server) preparePublishedApp(ctx context.Context, r *http.Request) (appchip.Request, bool, error) {
	if s.PublishedApp == nil {
		return appchip.Request{}, false, fallback.New("published-app-unconfigured")
	}
	if r.Method != http.MethodGet {
		return appchip.Request{}, false, fallback.New("method")
	}
	raw, err := trpc.ParseInput(r)
	if err != nil {
		return appchip.Request{}, false, fallback.Wrap("input-envelope", err)
	}
	in, err := appchip.Parse(raw)
	if err != nil {
		return appchip.Request{}, false, err
	}
	if r.Header.Get(verifiedBotHeader) != "" {
		return appchip.Request{}, false, fallback.New("verified-bot")
	}
	user, err := s.Resolver.Resolve(ctx, r)
	if err != nil {
		return appchip.Request{}, false, err
	}
	req := appchip.Request{Input: in, Banned: user != nil && user.Banned}
	if user != nil && !user.Banned {
		req.Viewer = &appchip.Viewer{ID: user.ID, IsModerator: user.IsModerator}
	}
	return req, user == nil, nil
}
