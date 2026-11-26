package evalharness

import (
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

// ViewerAnon is the viewer_used of a case replayed signed out.
const ViewerAnon = "anon"

// Mapping is how one case's viewer is replayed.
type Mapping struct {
	// NotReplayable is the not_replayable reason ("": replayable).
	NotReplayable string
	// Role is the member role whose account replays the case ("": signed out, unless APIKey).
	Role string
	// APIKey: replayed with the read-only API key (its owning account's identity), presented as the
	// stored credential class says: Header (Authorization: Bearer), Query (`token`), and the owning
	// account's session cookie too when the class also holds `session`.
	APIKey, Header, Query, Cookie bool
}

// MapViewer maps a case's viewer descriptor and credential class to the account that replays it. The
// first rule that applies wins:
//
//  1. a moderator or banned viewer: not replayable (no such eval account exists);
//  2. a credential class holding `header` or `query`: the read-only API key, presented the same way;
//  3. anon or crawler: signed out (no cookie; a stored verified-crawler header is sent as stored);
//  4. a user: `self` (the input named the viewer) member-owner; else hidden preferences
//     member-filtered; else mature (showNsfw, or a browsing level past browsing.SFWLevels)
//     member-mature; else member-default;
//  5. any other class: not replayable.
func MapViewer(v evalcorpus.ViewerDescriptor, credential string) Mapping {
	switch v.Class {
	case evalcorpus.ViewerModerator, evalcorpus.ViewerBanned:
		return Mapping{NotReplayable: "viewer:" + v.Class}
	}
	classes := map[string]bool{}
	for _, c := range strings.Split(credential, "+") {
		classes[c] = true
	}
	if classes[evalcorpus.CredentialHeader] || classes[evalcorpus.CredentialQuery] {
		return Mapping{APIKey: true, Header: classes[evalcorpus.CredentialHeader], Query: classes[evalcorpus.CredentialQuery],
			Cookie: classes[evalcorpus.CredentialSession]}
	}
	switch v.Class {
	case evalcorpus.ViewerAnon, evalcorpus.ViewerCrawler:
		return Mapping{}
	case evalcorpus.ViewerUser:
		switch {
		case v.Self:
			return Mapping{Role: RoleOwner, Cookie: true}
		case v.HiddenPrefs:
			return Mapping{Role: RoleFiltered, Cookie: true}
		case v.ShowNsfw || v.BrowsingLevel&^browsing.SFWLevels != 0:
			return Mapping{Role: RoleMature, Cookie: true}
		}
		return Mapping{Role: RoleDefault, Cookie: true}
	}
	return Mapping{NotReplayable: "viewer:unknown"}
}

// Credentials are what one case is replayed with: the account's identity (for the placeholders) and
// the credentials to present.
type Credentials struct {
	// ViewerUsed is the `results.viewer_used` value: anon, a member role, or apikey:<role>.
	ViewerUsed string
	// Identity is the account's (zero signed out).
	Identity Identity
	// Cookie is the session cookie's `name=value` ("": none); Bearer the API key for an
	// Authorization header, QueryToken the API key for a `token` query pair ("": none).
	Cookie, Bearer, QueryToken string
}

// Resolve turns a Mapping into the credentials of a loaded account, or a not_replayable reason.
func (a *Accounts) Resolve(m Mapping) (Credentials, string) {
	if m.NotReplayable != "" {
		return Credentials{}, m.NotReplayable
	}
	role := m.Role
	if m.APIKey {
		if a.apiKey == "" {
			return Credentials{}, "no-api-key"
		}
		role = a.apiKeyRole
	}
	if role == "" {
		return Credentials{ViewerUsed: ViewerAnon, Identity: Identity{SearchText: a.searchText}}, ""
	}
	acc := a.byRole[role]
	switch {
	case acc == nil:
		return Credentials{}, "no-account:" + role
	case acc.Expired:
		return Credentials{}, "account-expired:" + role
	}
	c := Credentials{ViewerUsed: role, Identity: Identity{
		UserID: acc.UserID, Username: acc.Username, CollectionID: acc.CollectionID, SearchText: acc.SearchText,
	}}
	if m.Cookie {
		c.Cookie = a.cookie + "=" + acc.token
	}
	if m.APIKey {
		c.ViewerUsed = "apikey:" + role
		if m.Header {
			c.Bearer = a.apiKey
		}
		if m.Query {
			c.QueryToken = a.apiKey
		}
	}
	return c, ""
}
