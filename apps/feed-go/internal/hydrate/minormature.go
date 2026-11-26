package hydrate

import "strconv"

// The minor-content visibility rule of the Node image reads (src/server/common/image-visibility.ts:
// minorMatureImageVisibleSql, isMinorMatureImage; the rating test is minorContentRestrictedSql in
// src/server/utils/minor-content-gate.sql.ts and isMinorContentRestricted in
// packages/civitai-shared/src/minor-content-gate.ts). An image whose `minor` flag is set and whose
// rating is missing (NULL), unrated (0) or R and above is shown only to its owner and to moderators;
// with no viewer it is shown to nobody. Every Go read of image rows that serves a Node read applying
// the rule goes through the helpers below (TestMinorMatureCallSites pins the list).

// MinorRestrictedFromLevel is MINOR_RESTRICTED_FROM_LEVEL (NsfwLevel.R): the lowest rated level the
// rule restricts.
const MinorRestrictedFromLevel = 4

// minorRestrictedSQL is minorContentRestrictedSql({ minor: COALESCE(<alias>."minor", FALSE),
// nsfwLevel: <alias>."nsfwLevel" }), with the level bound inlined as a literal (it is a constant).
func minorRestrictedSQL(alias string) string {
	level := alias + `."nsfwLevel"`
	return `((COALESCE(` + alias + `."minor", FALSE)) AND (` + level + ` IS NULL OR ` + level + ` = 0 OR ` +
		level + ` >= ` + strconv.Itoa(MinorRestrictedFromLevel) + `))`
}

// MinorMatureImageVisibleSQL is minorMatureImageVisibleSql({ userId: viewerID, isModerator }) over
// "Image" aliased alias: `TRUE` for a moderator; otherwise `(NOT <restricted>)`, with
// ` OR <alias>."userId" = <bind(viewerID)>` inside the parentheses when viewerID is not 0. bind adds
// a query argument and returns its placeholder; it is called once, only when viewerID is not 0.
func MinorMatureImageVisibleSQL(alias string, viewerID int, isModerator bool, bind func(any) string) string {
	if isModerator {
		return `TRUE`
	}
	own := ""
	if viewerID != 0 {
		own = ` OR ` + alias + `."userId" = ` + bind(viewerID)
	}
	return `(NOT ` + minorRestrictedSQL(alias) + own + `)`
}

// MinorMatureImageHiddenSQL is MinorMatureImageVisibleSQL with no viewer, which binds nothing: the
// clause of a viewer-independent read (the shared version-showcase cache's lookup).
func MinorMatureImageHiddenSQL(alias string) string {
	return MinorMatureImageVisibleSQL(alias, 0, false, nil)
}

// IsMinorRestrictedLevel is isMinorRestrictedLevel over a decoded nsfwLevel value: true for nil, for
// a number equal to 0 or at least MinorRestrictedFromLevel, and for a value of any other type (a
// level that is not a number counts as restricted, never as safe; a cached level is always a number).
func IsMinorRestrictedLevel(nsfwLevel any) bool {
	switch t := nsfwLevel.(type) {
	case nil:
		return true
	case float64:
		return t == 0 || t >= MinorRestrictedFromLevel
	case float32:
		return t == 0 || t >= MinorRestrictedFromLevel
	case string:
		return true
	}
	n, ok := Int(nsfwLevel)
	if !ok {
		return true
	}
	return n == 0 || n >= MinorRestrictedFromLevel
}

// IsMinorMatureImage is isMinorMatureImage over decoded values: minor is the boolean true (as
// `image.minor === true`) and IsMinorRestrictedLevel(nsfwLevel).
func IsMinorMatureImage(minor, nsfwLevel any) bool {
	m, ok := minor.(bool)
	return ok && m && IsMinorRestrictedLevel(nsfwLevel)
}

// WithoutMinorMatureImages is the imagesForModelVersionsCache appendFn's first step,
// `entry.images.filter((i) => !isMinorMatureImage(i))`, over images read with get (the cached
// image's `minor` and `nsfwLevel` members): the images it keeps, in their order, in a new slice.
func WithoutMinorMatureImages[T any](images []T, get func(T, string) any) []T {
	out := make([]T, 0, len(images))
	for _, img := range images {
		if !IsMinorMatureImage(get(img, "minor"), get(img, "nsfwLevel")) {
			out = append(out, img)
		}
	}
	return out
}
