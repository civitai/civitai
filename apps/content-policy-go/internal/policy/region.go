package policy

import (
	"fmt"
	"strings"
	"time"
)

// Rule is one entry of a region list (REGION_RESTRICTION_CONFIG or REGION_BLOCK_CONFIG): a region
// (a country, or `US:<state>`) held from the END of its effective date on. region-blocking.ts reads
// `YYYY-MM-DD` as `${date}T23:59:59.999Z` and applies the rule once that instant is reached, so a
// rule dated 2025-08-01 does not apply at 2025-08-01T12:00Z.
type Rule struct {
	Region string
	Date   string
	From   time.Time
}

// ParseRules is how region-blocking.ts reads REGION_RESTRICTION_CONFIG / REGION_BLOCK_CONFIG: an
// empty value is the default list; otherwise comma-separated `REGION:YYYY-MM-DD` entries, each
// trimmed, split at its LAST colon (so `US:NY:2025-07-24` is region `US:NY`), the region uppercased.
//
// One deliberate difference: a date that is not a real `YYYY-MM-DD` is an error here (the service
// refuses to start, as feed-go does), where the site would hand it to `new Date`, which either rolls
// it over (`2025-02-30` is March 2) or makes a rule that never applies. A list the site would crash
// on (an entry with no colon) is an error in both.
func ParseRules(env string, defaults []RuleSpec) ([]Rule, error) {
	if env == "" {
		out := make([]Rule, 0, len(defaults))
		for _, d := range defaults {
			r, err := newRule(d.Region, d.EffectiveDate)
			if err != nil {
				return nil, err
			}
			out = append(out, r)
		}
		return out, nil
	}
	parts := strings.Split(env, ",")
	out := make([]Rule, 0, len(parts))
	for _, part := range parts {
		entry := jsTrim(part)
		i := strings.LastIndex(entry, ":")
		if i < 0 {
			return nil, fmt.Errorf("invalid region config entry %q: no colon", entry)
		}
		r, err := newRule(jsUpper(entry[:i]), entry[i+1:])
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

func newRule(region, date string) (Rule, error) {
	day, err := time.Parse(time.DateOnly, date)
	if err != nil || day.Format(time.DateOnly) != date {
		return Rule{}, fmt.Errorf("invalid region config date %q for %q: want YYYY-MM-DD", date, region)
	}
	return Rule{Region: region, Date: date, From: day.Add(24*time.Hour - time.Millisecond)}, nil
}

// Location is what the edge stamped on a request, each value exactly as received (nil: the header
// was absent). Nothing is trimmed or uppercased before it is judged: the rules below do that where
// the site does, and only there.
type Location struct {
	Country *string // cf-ipcountry
	Region  *string // cf-region-code
	IsUK    *string // x-isuk
}

// regionInfo is getRegion's result: the country (x-isuk `true` or `1` makes it `GB`), the region
// code, and the full location code (`country:region` when both are non-empty, else the country).
type regionInfo struct {
	country *string
	full    *string
}

func resolve(l Location) regionInfo {
	country := l.Country
	if l.IsUK != nil && (*l.IsUK == "true" || *l.IsUK == "1") {
		gb := "GB"
		country = &gb
	}
	full := country
	if nonEmpty(country) && nonEmpty(l.Region) {
		f := *country + ":" + *l.Region
		full = &f
	}
	return regionInfo{country: country, full: full}
}

func nonEmpty(s *string) bool { return s != nil && *s != "" }

// matches is getRegionEffectiveDate + checkRegionStatus(…, 'past', at): the first rule naming the
// request's region applies once its date has passed. The region judged is the full location code,
// uppercased, when the country is exactly `US` (case-sensitive: `us` is judged by the country alone,
// as `US`), else the country uppercased. Neither is trimmed. No country, or an empty one, matches
// nothing.
func matches(rules []Rule, info regionInfo, at time.Time) bool {
	if !nonEmpty(info.country) || !nonEmpty(info.full) {
		return false
	}
	key := jsUpper(*info.country)
	if *info.country == "US" {
		key = jsUpper(*info.full)
	}
	for _, r := range rules {
		if r.Region == key {
			return !at.Before(r.From)
		}
	}
	return false
}

// countryKnown is the registry adapter's `countryKnown` (request-origin.ts): the country, trimmed and
// uppercased, is two letters A-Z and not one of the edge's codes that name no country (`XX`, `T1`).
func countryKnown(info regionInfo) bool {
	if info.country == nil {
		return false
	}
	upper := jsUpper(jsTrim(*info.country))
	if len(upper) != 2 || upper[0] < 'A' || upper[0] > 'Z' || upper[1] < 'A' || upper[1] > 'Z' {
		return false
	}
	for _, c := range data.NoCountryCodes {
		if upper == c {
			return false
		}
	}
	return true
}
