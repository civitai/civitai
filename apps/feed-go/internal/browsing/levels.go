// Package browsing ports the browsing-level rules the main app applies before and inside the image feed:
// the NSFW level bit flags, the per-request domain cap (`applyDomainFeature`), and the browsing-settings
// addons (`resolveBrowsingSettingsAddons`) that add POI/minor/tag exclusions.
package browsing

import (
	"strings"
	"time"
)

// NsfwLevel bits (src/server/common/enums.ts NsfwLevel).
const (
	PG      = 1
	PG13    = 2
	R       = 4
	X       = 8
	XXX     = 16
	Blocked = 32
)

const (
	// PublicLevels is publicBrowsingLevelsFlag.
	PublicLevels = PG
	// SFWLevels is sfwBrowsingLevelsFlag.
	SFWLevels = PG | PG13
	// NSFWLevels is nsfwBrowsingLevelsFlag (R|X|XXX|Blocked).
	NSFWLevels = R | X | XXX | Blocked
	// AllLevels is allBrowsingLevelsFlag (Blocked excluded).
	AllLevels = PG | PG13 | R | X | XXX
)

// OnlySelectable strips the Blocked bit (onlySelectableLevels).
func OnlySelectable(level int) int { return level &^ Blocked }

// DomainCap is domainBrowsingLevelCap: signed out -> PG, signed in where NSFW is not viewable -> PG/PG13,
// otherwise no cap (returned as 0).
func DomainCap(authorized, canViewNsfw bool) int {
	if !authorized {
		return PublicLevels
	}
	if !canViewNsfw {
		return SFWLevels
	}
	return 0
}

// ClampToCap is clampToDomainCap: `(requested ?? 0) & cap || cap`. cap 0 means "no cap".
func ClampToCap(requested, cap int) int {
	if cap == 0 {
		return requested
	}
	if v := requested & cap; v != 0 {
		return v
	}
	return cap
}

// IsPowerOfTwo mirrors the filter Flags.arrayToInstance applies.
func isPowerOfTwo(n int) bool { return n > 0 && n&(n-1) == 0 }

// ArrayToInstance sums the power-of-two values of levels (Flags.arrayToInstance).
func ArrayToInstance(levels []int) int {
	sum := 0
	for _, l := range levels {
		if isPowerOfTwo(l) {
			sum |= l
		}
	}
	return sum
}

// Addon is one BrowsingSettingsAddon entry (src/shared/constants/browsing-settings-addons.ts). Only the
// fields the image feed reads are kept.
type Addon struct {
	Type           string `json:"type"`
	NsfwLevels     []int  `json:"nsfwLevels"`
	Scope          string `json:"scope,omitempty"`
	DisablePoi     *bool  `json:"disablePoi,omitempty"`
	DisableMinor   *bool  `json:"disableMinor,omitempty"`
	ExcludedTagIDs []int  `json:"excludedTagIds,omitempty"`
}

// Resolved is the part of ResolvedBrowsingSettingsAddons the feed uses.
type Resolved struct {
	DisablePoi     bool
	DisableMinor   bool
	ExcludedTagIDs []int
}

// knownScopes is BROWSING_ADDON_SCOPES.
var knownScopes = map[string]bool{"newCreators": true}

// ResolveAddons is resolveBrowsingSettingsAddons. Moderators resolve to nothing.
func ResolveAddons(addons []Addon, level int, isModerator bool, scope string) Resolved {
	var r Resolved
	if isModerator {
		return r
	}
	for _, a := range addons {
		if a.Scope != "" {
			if !knownScopes[a.Scope] || a.Scope != scope {
				continue
			}
		}
		mask := ArrayToInstance(a.NsfwLevels)
		inter := level & mask
		apply := false
		switch a.Type {
		case "some":
			apply = inter != 0
		case "all":
			apply = inter == mask
		case "none":
			apply = inter == 0
		}
		if !apply {
			continue
		}
		if a.DisablePoi != nil {
			r.DisablePoi = *a.DisablePoi
		}
		if a.DisableMinor != nil {
			r.DisableMinor = *a.DisableMinor
		}
		r.ExcludedTagIDs = append(r.ExcludedTagIDs, a.ExcludedTagIDs...)
	}
	return r
}

func ptr(b bool) *bool { return &b }

// peopleTagIDs / childTagIDs are the tag groups the default addons exclude.
var (
	peopleTagIDs = []int{5161, 5162, 5188, 5249, 130818, 130820, 133182, 130401, 110980}
	childTagIDs  = []int{5351, 306619, 154326, 161829, 163032}
)

// DefaultAddons is DEFAULT_BROWSING_SETTINGS_ADDONS, used when the system redis key is absent or invalid.
var DefaultAddons = []Addon{
	{Type: "none", NsfwLevels: []int{X, XXX}},
	{Type: "some", NsfwLevels: []int{PG, PG13, R, X, XXX}, DisablePoi: ptr(true), ExcludedTagIDs: peopleTagIDs},
	{Type: "some", NsfwLevels: []int{R, X, XXX}, DisableMinor: ptr(true), ExcludedTagIDs: childTagIDs},
}

// HostColors maps a domain color to its hosts (SERVER_DOMAIN_<COLOR> plus SERVER_DOMAIN_<COLOR>_ALIASES).
type HostColors map[string][]string

// ColorOf returns the color whose host list contains host (port stripped, case-insensitive), walking
// green, blue, red in order as getRequestDomainColor does, or "" when no color matches.
func (h HostColors) ColorOf(host string) string {
	host = strings.ToLower(host)
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	for _, color := range []string{"green", "blue", "red"} {
		for _, candidate := range h[color] {
			if strings.EqualFold(candidate, host) {
				return color
			}
		}
	}
	return ""
}

// RegionRule is one REGION_RESTRICTION_CONFIG entry: a region (country, or "US:<state>") restricted from
// an effective date on.
type RegionRule struct {
	Region    string
	Effective time.Time
}

// IsRegionRestricted is isRegionRestricted() for the cf-ipcountry/cf-region-code headers.
func IsRegionRestricted(rules []RegionRule, country, region string, now time.Time) bool {
	if country == "" {
		return false
	}
	check := strings.ToUpper(country)
	if check == "US" {
		if region == "" {
			check = "US"
		} else {
			check = "US:" + strings.ToUpper(region)
		}
	}
	for _, r := range rules {
		if r.Region == check {
			return !now.Before(r.Effective)
		}
	}
	return false
}

// CanViewNsfw evaluates the `canViewNsfw` feature (availability public + blue + red + nonRestricted).
// Moderators skip the region gate, as in the feature-flag service.
func CanViewNsfw(hostColor string, regionRestricted, isModerator bool) bool {
	if hostColor != "blue" && hostColor != "red" {
		return false
	}
	if regionRestricted && !isModerator {
		return false
	}
	return true
}
