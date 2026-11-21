package server

import (
	"context"
	"net/http"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// ProcedureAssociated is the tRPC procedure shadowed at /internal/shadow/<it> (a model page's
// Suggested Resources). Shadow only: no public route serves it (DESIGN.md §17).
const ProcedureAssociated = "model.getAssociatedResourcesCardData"

// EndpointAssociated is its feed_endpoint label.
const EndpointAssociated = "model-associated"

// ShadowAssociatedHandler is the internal compare endpoint for the tRPC procedure
// `model.getAssociatedResourcesCardData`.
func (s *Server) ShadowAssociatedHandler(w http.ResponseWriter, r *http.Request) {
	s.shadowHandler(w, r, EndpointAssociated) //nolint:contextcheck // the sample is compared after the 202 is written, on the server's background context: it must outlive the request
}

// SyntheticAssociatedRequest rebuilds the request a model-associated sample describes.
func SyntheticAssociatedRequest(ctx context.Context, req ShadowRequest) (*http.Request, error) {
	return syntheticTRPCRequest(ctx, req, ProcedureAssociated)
}

// associatedRoute is compare's dispatch for the procedure: the request rebuild, the compute and the
// classification (the superjson envelope of an array of cards, keyed by model id).
func (s *Server) associatedRoute(endpoint string) (
	build func(context.Context, ShadowRequest) (*http.Request, error),
	compute func(context.Context, *http.Request) (*computed, error),
	classify func(*shadow.Report, []byte, []byte) string,
	ok bool,
) {
	if endpoint != EndpointAssociated {
		return nil, nil, nil, false
	}
	compute = s.computeAssociated
	if s.computeAssociatedFn != nil {
		compute = s.computeAssociatedFn
	}
	return SyntheticAssociatedRequest, compute, shadow.ClassifyArray, true
}

// computeAssociated answers a `model.getAssociatedResourcesCardData` request
// (getAssociatedResourcesCardDataHandler), or returns a fallback/other error. Viewer, domain cap and
// region rules are read as for the gallery procedure (the same publicProcedure middleware). Cache
// policy is createContext's: nothing in this procedure's chain changes it, so a signed-out answer
// carries the public TTL and a session's none.
func (s *Server) computeAssociated(ctx context.Context, r *http.Request) (*computed, error) {
	req, signedOut, err := s.prepareAssociated(ctx, r)
	if err != nil {
		return nil, err
	}
	ans, err := modelfeed.ServeAssociated(ctx, s.Associated, req)
	if err != nil {
		return nil, err
	}
	buf, err := superjson.SerializeBuffer(ans.Value)
	if err != nil {
		return nil, err
	}
	out := &computed{payload: buf.Bytes(), buf: buf, trivial: ans.Trivial}
	if signedOut {
		out.ttl = &trpc.SignedOutTTL
	}
	return out, nil
}

// prepareAssociated is computeAssociated up to the handler call, and whether there is no session user
// at all; the Go-first probe runs the same steps.
func (s *Server) prepareAssociated(ctx context.Context, r *http.Request) (modelfeed.AssocRequest, bool, error) {
	if s.Associated == nil {
		return modelfeed.AssocRequest{}, false, fallback.New("model-assoc-unconfigured")
	}
	if r.Method != http.MethodGet {
		return modelfeed.AssocRequest{}, false, fallback.New("method")
	}
	raw, err := trpc.ParseInput(r)
	if err != nil {
		return modelfeed.AssocRequest{}, false, fallback.Wrap("input-envelope", err)
	}
	in, err := modelfeed.ParseAssociated(raw)
	if err != nil {
		return modelfeed.AssocRequest{}, false, err
	}
	if r.Header.Get(verifiedBotHeader) != "" {
		return modelfeed.AssocRequest{}, false, fallback.New("verified-bot")
	}
	user, err := s.Resolver.Resolve(ctx, r)
	if err != nil {
		return modelfeed.AssocRequest{}, false, err
	}
	authorized := user != nil && !user.Banned
	isModerator := authorized && user.IsModerator
	color := s.Hosts.ColorOf(r.Host)
	restricted := browsing.IsRegionRestricted(s.RegionRules, countryOf(r), r.Header.Get("cf-region-code"), time.Now())
	req := modelfeed.AssocRequest{
		Input:  in,
		Banned: user != nil && user.Banned,
		Cap:    browsing.DomainCap(authorized, browsing.CanViewNsfw(color, restricted, isModerator)),
	}
	if authorized {
		req.Viewer = &modelfeed.Viewer{ID: user.ID, Username: user.Username, IsModerator: isModerator}
	}
	return req, user == nil, nil
}
