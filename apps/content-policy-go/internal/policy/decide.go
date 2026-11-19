// Package policy decides what content a viewer may be shown, as the site and the registry adapter
// decide it today: which content ratings, which browsing level, and whether the viewer's region is
// held to SFW content or refused. It is a port of the Node code named on each function, checked
// against vectors the REAL Node code generates (testdata/golden/gen.ts).
//
// The callers do not agree with each other (an unknown country, a blocked region, the host, an
// unknown rating, a moderator); each disagreement is a named rule (contexts.go), and each caller
// context picks its own value, so every caller keeps its own behaviour.
package policy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"time"
)

// Region holds.
const (
	HoldNone       = "none"
	HoldRestricted = "restricted"
	HoldBlocked    = "blocked"
)

// Holds is every RegionHold value.
var Holds = []string{HoldNone, HoldRestricted, HoldBlocked}

// Reasons: what decided the answer, the first that applies, in this order.
const (
	ReasonError            = "error"             // the service could not decide; the SFW decision
	ReasonInvalidInput     = "invalid-input"     // the request was malformed; the SFW decision
	ReasonUnknownCountry   = "unknown-country"   // held: the country cannot be told (UnknownCountryHold)
	ReasonRegionBlocked    = "region-blocked"    // a blocked region (held or refused)
	ReasonRegionRestricted = "region-restricted" // a region restricted to SFW
	ReasonModeratorBypass  = "moderator-bypass"  // a restricted region a moderator is let past
	ReasonHostSFW          = "host-sfw"          // the host turns mature content off (NsfwHostColor)
	ReasonUnrestricted     = "unrestricted"      // LevelAPI outside a held region
	ReasonAnonymous        = "anonymous"         // no user
	ReasonUserUnavailable  = "user-unavailable"  // a user id with no usable user: decided as anonymous
	ReasonUserSettings     = "user-settings"     // the user's own settings
)

// Reasons is every Reason value.
var Reasons = []string{
	ReasonError, ReasonInvalidInput, ReasonUnknownCountry, ReasonRegionBlocked, ReasonRegionRestricted,
	ReasonModeratorBypass, ReasonHostSFW, ReasonUnrestricted, ReasonAnonymous, ReasonUserUnavailable,
	ReasonUserSettings,
}

// Viewer is who is asking.
type Viewer int

const (
	// Anonymous: no user id.
	Anonymous Viewer = iota
	// SignedIn: a user whose settings were read.
	SignedIn
	// Unavailable: a user id with no usable user (none, deleted or banned). Decided as Anonymous: the
	// narrowest viewer, and what every caller already serves a request it cannot tie to a user.
	Unavailable
)

// User is the part of a user's row a decision reads ("User"."showNsfw", "browsingLevel",
// "isModerator"; a null isModerator is false, as the session reads it).
type User struct {
	ShowNsfw      bool  `json:"showNsfw"`
	BrowsingLevel int32 `json:"browsingLevel"`
	IsModerator   bool  `json:"isModerator"`
}

// Input is one decision's input.
type Input struct {
	Context string
	Location
	// Host is the request's domain color: "green", "blue" or "red"; "" when there was no host; any
	// other value is a host of no color.
	Host   string
	Viewer Viewer
	User   User // read only when Viewer is SignedIn
	At     time.Time
}

// Decision is the answer.
type Decision struct {
	// Ratings are the content ratings the viewer may be sent, in Ratings order. Empty when refused.
	Ratings []string `json:"ratings"`
	// UnknownRating is whether an item with no rating, or one outside the ladder, may be sent.
	UnknownRating bool `json:"unknownRating"`
	// BrowsingLevel is the viewer's browsing level (NsfwLevel bits). 0 when refused.
	BrowsingLevel int32 `json:"browsingLevel"`
	// RegionHold is the hold applied: none, restricted (SFW only) or blocked (held to SFW, or refused
	// with no ratings at all, as the context's BlockedRegion says).
	RegionHold string `json:"regionHold"`
	Reason     string `json:"reason"`
}

// ErrUnknownContext is returned for a context not in Contexts.
var ErrUnknownContext = errors.New("unknown context")

// Engine decides with one pair of region lists.
type Engine struct {
	Restricted []Rule // REGION_RESTRICTION_CONFIG
	Blocked    []Rule // REGION_BLOCK_CONFIG
	version    string
}

// NewEngine builds an engine over the two region lists and computes its PolicyVersion.
func NewEngine(restricted, blocked []Rule) *Engine {
	e := &Engine{Restricted: restricted, Blocked: blocked}
	sum := sha256.New()
	// Everything a decision reads besides its input: the data file, the context rules and both lists.
	// json.Marshal of these types cannot fail.
	rules, _ := json.Marshal(struct {
		Contexts   map[string]Rules
		Restricted []Rule
		Blocked    []Rule
	}{Contexts, restricted, blocked})
	sum.Write(dataJSON)
	sum.Write(rules)
	e.version = hex.EncodeToString(sum.Sum(nil))[:12]
	return e
}

// PolicyVersion names the policy in force: it changes when the data file, a context's rules or a
// region list does. A caller may key its cache on it.
func (e *Engine) PolicyVersion() string { return e.version }

// SFW is the decision a caller falls back to when nothing better can be said: the non-mature
// ratings, browsing level PG, no unknown rating, held. The service answers it for every error and
// every malformed request, with `reason` saying which.
func SFW(reason string) Decision {
	var ratings []string
	for _, r := range Ratings {
		if !isMature(r) {
			ratings = append(ratings, r)
		}
	}
	return Decision{
		Ratings:       ratings,
		UnknownRating: false,
		BrowsingLevel: data.Levels.Public,
		RegionHold:    HoldRestricted,
		Reason:        reason,
	}
}

// Decide answers one input.
func (e *Engine) Decide(in Input) (Decision, error) {
	rules, ok := Contexts[in.Context]
	if !ok {
		return SFW(ReasonInvalidInput), ErrUnknownContext
	}
	info := resolve(in.Location)
	blocked := matches(e.Blocked, info, in.At)
	restricted := matches(e.Restricted, info, in.At)
	signedIn := in.Viewer == SignedIn

	hold, reason := HoldNone, ""
	switch {
	case rules.UnknownCountry == UnknownCountryHold && !countryKnown(info):
		hold, reason = HoldRestricted, ReasonUnknownCountry
	case blocked:
		if rules.BlockedRegion == BlockedRegionRefuse {
			return Decision{Ratings: []string{}, RegionHold: HoldBlocked, Reason: ReasonRegionBlocked}, nil
		}
		hold, reason = HoldBlocked, ReasonRegionBlocked
	case restricted && rules.ModeratorBypass && signedIn && in.User.IsModerator:
		reason = ReasonModeratorBypass
	case restricted:
		hold, reason = HoldRestricted, ReasonRegionRestricted
	}
	held := hold != HoldNone

	var level int32
	switch rules.Level {
	case LevelAPI:
		level = data.Levels.All
		if held {
			level = data.Levels.SFW
		}
		if reason == "" {
			reason = ReasonUnrestricted
		}
	default: // LevelViewer
		hostOK := hostAllowsNsfw(rules.NsfwHost, in.Host)
		level = serverBrowsingLevel(!held && hostOK, signedIn, in.User)
		if reason == "" {
			switch {
			case !hostOK:
				reason = ReasonHostSFW
			case in.Viewer == Unavailable:
				reason = ReasonUserUnavailable
			case signedIn:
				reason = ReasonUserSettings
			default:
				reason = ReasonAnonymous
			}
		}
	}

	var surface bool
	switch rules.RatingSurface {
	case RatingSurfaceUnlessHeld:
		surface = !held
	case RatingSurfaceRedHost:
		surface = in.Host == "red"
	default: // RatingSurfaceAlways
		surface = true
	}
	allowed := matureRatingsAllowed(surface, level)
	admits := func(rating string) bool { return admitsRating(rules.UnknownRating, allowed, rating) }
	ratings := []string{}
	for _, r := range Ratings {
		if admits(r) {
			ratings = append(ratings, r)
		}
	}
	return Decision{
		Ratings:       ratings,
		UnknownRating: admits(""),
		BrowsingLevel: level,
		RegionHold:    hold,
		Reason:        reason,
	}, nil
}

// hostAllowsNsfw is the server half of the `canViewNsfw` feature (availability blue + red): a host
// of either color passes, and so does no host at all (hasFeature skips the check without one).
func hostAllowsNsfw(rule NsfwHostRule, host string) bool {
	if rule == NsfwHostIgnored {
		return true
	}
	return host == "" || host == "blue" || host == "red"
}

// serverBrowsingLevel is getServerBrowsingLevel (src/server/utils/browsing-level.ts).
func serverBrowsingLevel(canViewNsfw, signedIn bool, u User) int32 {
	if !canViewNsfw {
		if signedIn {
			return data.Levels.SFW
		}
		return data.Levels.Public
	}
	if signedIn && u.ShowNsfw && u.BrowsingLevel != 0 {
		return u.BrowsingLevel
	}
	return data.Levels.Public
}

// mature is MatureRatingsAllowed (app-listing-store-gate.ts).
type mature struct{ r, x, xxx bool }

// matureRatingsAllowed is matureRatingsAllowed: none off a mature-capable surface; on one, each by
// its level bit. (onlySelectableLevels clears only the Blocked bit, which none of the three reads.)
func matureRatingsAllowed(surface bool, level int32) mature {
	if !surface {
		return mature{}
	}
	return mature{r: level&data.Levels.R != 0, x: level&data.Levels.X != 0, xxx: level&data.Levels.XXX != 0}
}

func isMature(rating string) bool { return slices.Contains(data.MatureRatings, rating) }

// matureRatingAllowed is matureRatingAllowed: a rating that is not mature always passes; r by r, xxx
// by xxx, and the other mature rating (x) by x.
func matureRatingAllowed(rating string, a mature) bool {
	if !isMature(rating) {
		return true
	}
	switch rating {
	case "r":
		return a.r
	case "xxx":
		return a.xxx
	default:
		return a.x
	}
}

// admitsRating is audienceAdmits (UnknownRatingClosed; the audience never admits XXX itself, so xxx is
// read as an unknown rating) or matureRatingAllowed (UnknownRatingOpen). Ratings are lowercase here;
// both Node predicates lowercase theirs.
func admitsRating(rule UnknownRatingRule, a mature, rating string) bool {
	if rule == UnknownRatingClosed {
		if slices.Contains(data.RatingLadder, rating) {
			return matureRatingAllowed(rating, mature{r: a.r, x: a.x})
		}
		return a.r && a.x
	}
	return matureRatingAllowed(rating, a)
}
