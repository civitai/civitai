package modelfeed

import (
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// Page query: getModelsRaw's SQL (src/server/services/model.service.ts), clause by clause, for the
// supported inputs. Values are bound ($n); the constants Node binds (enum literals) are inlined, and
// the lists Node joins into `IN (…)` are bound as arrays (`= ANY($n)`), which Postgres evaluates the
// same way. Every clause names the Node line it follows in the order getModelsRaw pushes them.

// PageQuery is one getModelsRaw call's inputs, resolved (the viewer's addon exclusions applied, the
// tag and creator looked up).
type PageQuery struct {
	Take   int
	Cursor string
	Sort   string
	// PeriodCutoff is `decreaseDate(new Date(), 1, period)` when the period filter applies; zero = none.
	PeriodCutoff  time.Time
	BrowsingLevel int
	// ViewerID is the session user (0 = signed out: bound as NULL, as Node binds `undefined`).
	ViewerID     int
	IsModerator  bool
	Archived     bool
	DisablePoi   bool
	DisableMinor bool
	// ExcludedTagIDs is the resolved list (the request's plus the browsing-settings addons').
	ExcludedTagIDs []int
	// TagID is the `tag`/`tagname` filter's tag (0 = none, also when the name found no tag).
	TagID        int
	FromPlatform bool
	// TargetUserID is the `username || user` filter's user (0 = none).
	TargetUserID          int
	Types                 []string
	BaseModels            []string
	CheckpointType        string
	AllowCommercialUse    []string
	AllowDerivatives      *bool
	AllowDifferentLicense *bool
	AllowNoCredit         *bool
	EarlyAccess           bool
	PaidAccess            bool
	HidePaid              bool
	// HidePrivate is getModelsRaw's hidePrivateModels (Serve): under HidePaid, the free version that
	// keeps a gated model must then also be Public.
	HidePrivate     bool
	OnSale          bool
	ExcludedUserIDs []int
	FileFormats     []string
	// CollectionID is the collection filter (0 = none), applied only once the viewer may read the
	// collection (servePage); CollectionTagID narrows it to one collection tag (0 = none).
	CollectionID    int
	CollectionTagID int
	// OnlyModelIDs / ExcludeModelIDs are getModelsRaw's onlyModelIds / excludeModelIds: the browse
	// feed's official-checkpoint pin (Serve). Neither relaxes the private-model filter.
	OnlyModelIDs    []int
	ExcludeModelIDs []int
	// IDs is the `ids` input (Input.IDs): a non-empty list filters the page to those models.
	IDs []int
	// Followed is `followed` with a signed-in viewer: the page is held to FollowedUserIDs, the creators
	// the viewer follows, or to nothing (`1 = 0`) when they follow no one.
	Followed        bool
	FollowedUserIDs []int
}

// SQL is one statement and its arguments.
type SQL struct {
	Text string
	Args []any
}

type builder struct{ args []any }

// withheldViewerSlot stands for the taken-down clause's viewer until Build binds it, last.
const withheldViewerSlot = "\x00withheld-viewer\x00"

// arg binds v and returns its placeholder.
func (b *builder) arg(v any) string {
	b.args = append(b.args, v)
	return "$" + strconv.Itoa(len(b.args))
}

// viewer binds the session user id, NULL when signed out.
func (b *builder) viewer(id int) string {
	if id == 0 {
		return b.arg(nil)
	}
	return b.arg(id)
}

// paidAccessLiveSQL is paidAccessLiveSql (src/server/services/paid-access-sql.ts).
const paidAccessLiveSQL = `pa."entityType" = 'ModelVersion'
      AND (pa."endsAt" IS NULL OR pa."endsAt" > NOW())
      AND mv.status = 'Published'::"ModelStatus"`

// freePublishedVersionExistsSQL is freePublishedVersionExistsSql over `m.id` (paid-access-sql.ts): the
// model has a Published version with no live gate; publicOnly also requires that version be Public.
func freePublishedVersionExistsSQL(publicOnly bool) string {
	public := ""
	if publicOnly {
		public = `
        AND fv.availability = 'Public'::"Availability"`
	}
	return `EXISTS (
      SELECT 1 FROM "ModelVersion" fv
      WHERE fv."modelId" = m.id
        AND fv.status = 'Published'::"ModelStatus"` + public + `
        AND NOT EXISTS (
          SELECT 1 FROM "PaidAccess" pa
          JOIN "ModelVersion" mv ON mv.id = pa."entityId"
          WHERE ` + paidAccessLiveSQL + `
            AND mv.id = fv.id
        )
    )`
}

// orderBy is getModelsRaw's ORDER BY for a sort, over the alias that carries the per-base-model
// columns.
func orderBy(sort, p string) string {
	switch sort {
	case SortHot:
		return p + `."hotScore" DESC, ` + p + `."modelId"`
	case SortHighestRated, SortMostLiked:
		return p + `."thumbsUpCount" DESC, ` + p + `."downloadCount" DESC, ` + p + `."modelId"`
	case SortMostDownloaded:
		return p + `."downloadCount" DESC, ` + p + `."thumbsUpCount" DESC, ` + p + `."modelId"`
	case SortMostDiscussed:
		return `mm."commentCount" DESC, ` + p + `."thumbsUpCount" DESC, ` + p + `."modelId"`
	case SortMostCollected:
		return `mm."collectedCount" DESC, ` + p + `."thumbsUpCount" DESC, ` + p + `."modelId"`
	case SortImageCount:
		return p + `."imageCount" DESC, ` + p + `."thumbsUpCount" DESC, ` + p + `."modelId"`
	case SortOldest:
		return `mm."lastVersionAt" ASC, ` + p + `."modelId"`
	}
	// Newest, and the default.
	return `mm."lastVersionAt" DESC NULLS LAST, ` + p + `."modelId" DESC`
}

type sortField struct {
	field string
	desc  bool
}

// parseSortString is parseSortString (src/server/utils/pagination-helpers.ts): split on `,`, then on
// spaces; the first token is the field, the second the order (ASC when absent). `NULLS LAST` is a
// third token and is dropped.
func parseSortString(s string) []sortField {
	parts := strings.Split(s, ",")
	out := make([]sortField, 0, len(parts))
	for _, part := range parts {
		toks := strings.Fields(part)
		f := sortField{field: toks[0]}
		if len(toks) > 1 {
			f.desc = strings.ToUpper(toks[1]) == "DESC"
		}
		out = append(out, f)
	}
	return out
}

// cursorProp is getCursorClauses' `prop`: the cursorId column a row hands out as the next cursor.
func cursorProp(fields []sortField) string {
	if len(fields) == 1 {
		return fields[0].field
	}
	names := make([]string, len(fields))
	for i, f := range fields {
		names[i] = f.field
	}
	return "CONCAT(" + strings.Join(names, ", '|', ") + ")"
}

var numericToken = regexp.MustCompile(`^-?\d+$`)

// cursorTimestamp reads a timestamp token as the instant it names: what Postgres writes for a
// `timestamp(3)` in CONCAT ("2006-01-02 15:04:05[.fff]", trailing zeros of the fraction trimmed),
// the fraction read as a decimal fraction of a second and kept to the millisecond, so ".25" is
// 250 ms and ".5" 500 ms, as Node reads it (the fraction padded to three digits). Any other
// date-like token falls back as model-cursor.
func cursorTimestamp(tok string) (time.Time, error) {
	for _, layout := range []string{"2006-01-02 15:04:05.999999999", "2006-01-02T15:04:05.999999999"} {
		if t, err := time.Parse(layout, tok); err == nil {
			return t.Truncate(time.Millisecond), nil
		}
	}
	return time.Time{}, fallback.New("model-cursor")
}

// parseInt is JavaScript's parseInt(value, 10) over a token known not to be date-like: leading
// whitespace, an optional sign, then the longest run of digits. ok is false where it gives NaN.
func parseInt(tok string) (int64, bool) {
	s := strings.TrimLeft(tok, " \t\n\r\v\f")
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		s = s[1:]
	}
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0, false
	}
	if end > 12 {
		return 0, false // far outside int4; the range check below refuses it either way
	}
	n, _ := strconv.ParseInt(s[:end], 10, 64)
	if neg {
		n = -n
	}
	return n, true
}

// cursorMin / int4Max are CURSOR_MIN and INT4_MAX (src/server/schema/base.schema.ts).
const (
	cursorMin = 0
	int4Max   = 2147483647
)

// parseCursor is parseCursor for a string cursor: one token per sort field, each a timestamp (a
// token with `-` that is not a plain integer) or an integer (parseInt) within [CURSOR_MIN, INT4_MAX].
// Anything Node answers with a 400 — a wrong arity, an empty token (a NULL column in the CONCAT), an
// unparseable date or number, a number out of range — falls back as model-cursor.
func parseCursor(fields []sortField, cursor string) ([]any, error) {
	toks := strings.Split(cursor, "|")
	if len(toks) != len(fields) {
		return nil, fallback.Safef("model-cursor", "%d tokens for %d fields", len(toks), len(fields))
	}
	out := make([]any, len(toks))
	for i, tok := range toks {
		if strings.Contains(tok, "-") && !numericToken.MatchString(tok) {
			t, err := cursorTimestamp(tok)
			if err != nil {
				return nil, err
			}
			out[i] = t
			continue
		}
		n, ok := parseInt(tok)
		if !ok || n < cursorMin || n > int4Max {
			return nil, fallback.New("model-cursor")
		}
		out[i] = n
	}
	return out, nil
}

// cursorClauses is getCursorClauses: with no cursor, nothing; for a sort whose head fields are all
// DESC (every multi-field sort but Oldest), a strict tuple compare and an equality branch, to be
// combined with UNION ALL (splittable); otherwise the legacy OR predicate, ANDed into the WHERE.
type cursorClauses struct {
	strict, equality string
	splittable       bool
}

// cursorOperator is cursorOperator: inclusive on the last sort field, strict on every head field.
func cursorOperator(desc, last bool) string {
	switch {
	case desc && last:
		return "<="
	case desc:
		return "<"
	case last:
		return ">="
	}
	return ">"
}

func (b *builder) cursorClauses(fields []sortField, cursor string) (cursorClauses, error) {
	if cursor == "" {
		return cursorClauses{}, nil
	}
	values, err := parseCursor(fields, cursor)
	if err != nil {
		return cursorClauses{}, err
	}
	// Each cursor value is bound once per use, as Prisma binds each template interpolation.
	legacy := func() string {
		conds := make([]string, 0, len(fields))
		last := len(fields) - 1
		for i := range fields {
			parts := make([]string, 0, i+1)
			for j := 0; j <= i; j++ {
				op := "="
				if j == i {
					op = cursorOperator(fields[j].desc, i == last)
				}
				parts = append(parts, fields[j].field+" "+op+" "+b.arg(values[j]))
			}
			conds = append(conds, "("+strings.Join(parts, " AND ")+")")
		}
		return "(" + strings.Join(conds, " OR ") + ")"
	}
	if len(fields) == 1 {
		return cursorClauses{strict: legacy()}, nil
	}
	last := len(fields) - 1
	for _, f := range fields[:last] {
		if !f.desc {
			return cursorClauses{strict: legacy()}, nil
		}
	}
	names := make([]string, last)
	vals := make([]string, last)
	for i, f := range fields[:last] {
		names[i] = f.field
		vals[i] = b.arg(values[i])
	}
	strict := "((" + strings.Join(names, ", ") + ") < (" + strings.Join(vals, ", ") + "))"
	eq := make([]string, 0, len(fields))
	for i, f := range fields[:last] {
		eq = append(eq, f.field+" = "+b.arg(values[i]))
	}
	lf := fields[last]
	eq = append(eq, lf.field+" "+cursorOperator(lf.desc, true)+" "+b.arg(values[last]))
	return cursorClauses{strict: strict, equality: "(" + strings.Join(eq, " AND ") + ")", splittable: true}, nil
}

// Build is getModelsRaw's model query. It returns a fallback for a cursor Node would answer with a 400.
func (q *PageQuery) Build() (SQL, error) {
	b := &builder{}
	var and []string
	// base-model-feed-metrics on (the state production runs; Serve refuses the other): a base-model
	// filter reads the per-base-model metric tables.
	useBM := len(q.BaseModels) > 0
	multiDriven := useBM && len(q.BaseModels) > 1 && (q.Sort == SortNewest || q.Sort == SortOldest || q.Sort == SortHot)
	p := "mm"
	if useBM && !multiDriven {
		p = "mbm"
	}
	rankP := p
	if multiDriven {
		rankP = "mbm"
	}

	if !q.Archived {
		and = append(and, `(`+p+`."mode" IS NULL OR `+p+`."mode" != 'Archived'::"ModelModifier")`)
	}
	// Port of modelNotWithheldSql (src/server/utils/model-withheld.ts): a taken-down model is its
	// owner's and moderators' alone.
	if !q.IsModerator {
		withheld := `(` + p + `."mode" IS DISTINCT FROM 'TakenDown'::"ModelModifier"`
		if q.ViewerID != 0 {
			withheld += ` OR mm."userId" = ` + withheldViewerSlot
		}
		and = append(and, withheld+`)`)
	}
	if q.DisablePoi {
		and = append(and, `(`+p+`."poi" = false OR mm."userId" = `+b.viewer(q.ViewerID)+`)`)
	}
	if q.DisableMinor {
		if q.ViewerID != 0 {
			and = append(and, `(`+p+`."minor" = false OR mm."userId" = `+b.arg(q.ViewerID)+`)`)
		} else {
			and = append(and, p+`."minor" = false`)
		}
	}
	if len(q.ExcludedTagIDs) > 0 {
		notExcluded := `NOT EXISTS (
      SELECT 1 FROM "TagsOnModels" tom
      WHERE tom."modelId" = m."id"
        AND tom."tagId" = ANY(` + b.arg(uniqueInts(q.ExcludedTagIDs)) + `::int[])
    )`
		if q.ViewerID != 0 {
			and = append(and, `(`+notExcluded+` OR m."userId" = `+b.arg(q.ViewerID)+`)`)
		} else {
			and = append(and, notExcluded)
		}
	}
	if q.TagID != 0 {
		and = append(and, `EXISTS (
            SELECT 1 FROM "TagsOnModels" tom
            WHERE tom."modelId" = m."id" AND tom."tagId" = `+b.arg(q.TagID)+`
          )`)
	}
	if q.FromPlatform {
		and = append(and, `EXISTS (
      SELECT 1 FROM "ModelVersion" mv
      WHERE mv."trainingStatus" IS NOT NULL AND mv."modelId" = m."id"
    )`)
	}
	if q.TargetUserID != 0 {
		and = append(and, `mm."userId" = `+b.arg(q.TargetUserID))
	}
	if len(q.Types) > 0 {
		and = append(and, `m.type = ANY(`+b.arg(q.Types)+`::text[]::"ModelType"[])`)
	}
	// `followed && sessionUser?.id`: the viewer's follows (`IN (…)`), or no row at all.
	if q.Followed {
		if len(q.FollowedUserIDs) == 0 {
			and = append(and, `1 = 0`)
		} else {
			and = append(and, `mm."userId" = ANY(`+b.arg(q.FollowedUserIDs)+`::int[])`)
		}
	}
	switch {
	case useBM && len(q.BaseModels) == 1:
		and = append(and, `mbm."baseModel" = `+b.arg(q.BaseModels[0]))
	case multiDriven:
		and = append(and, `EXISTS (
          SELECT 1 FROM "ModelBaseModelMetric" mbmm
          WHERE mbmm."modelId" = mm."modelId"
            AND mbmm."baseModel" = ANY(`+b.arg(q.BaseModels)+`::text[])
        )`)
	}
	if !q.PeriodCutoff.IsZero() {
		and = append(and, `(mm."lastVersionAt" >= `+b.arg(q.PeriodCutoff)+`)`)
	}
	// `!sessionUser?.isModerator || !status?.length`: status is not ported, so always Published.
	and = append(and, p+`."status" = 'Published'::"ModelStatus"`)
	if len(q.AllowCommercialUse) > 0 {
		and = append(and, `m."allowCommercialUse" && `+b.arg(q.AllowCommercialUse)+`::text[]::"CommercialUse"[]`)
	}
	if q.AllowDerivatives != nil {
		and = append(and, `m."allowDerivatives" = `+b.arg(*q.AllowDerivatives))
	}
	if q.AllowDifferentLicense != nil {
		and = append(and, `m."allowDifferentLicense" = `+b.arg(*q.AllowDifferentLicense))
	}
	if q.AllowNoCredit != nil {
		and = append(and, `m."allowNoCredit" = `+b.arg(*q.AllowNoCredit))
	}
	// `!!ids?.length` (`IN (…)`), then onlyModelIds and excludeModelIds, as `IN (…)` / `NOT IN (…)`.
	// The ids clause casts to `integer[]` (the same type as `int[]`) so its text is not the pin's.
	if len(q.IDs) > 0 {
		and = append(and, `mm."modelId" = ANY(`+b.arg(q.IDs)+`::integer[])`)
	}
	if len(q.OnlyModelIDs) > 0 {
		and = append(and, `mm."modelId" = ANY(`+b.arg(q.OnlyModelIDs)+`::int[])`)
	}
	if len(q.ExcludeModelIDs) > 0 {
		and = append(and, `mm."modelId" != ALL(`+b.arg(q.ExcludeModelIDs)+`::int[])`)
	}
	if q.CheckpointType != "" && (len(q.Types) == 0 || contains(q.Types, "Checkpoint")) {
		or := []string{`m."checkpointType" = ` + b.arg(q.CheckpointType) + `::text::"CheckpointType"`}
		var other []string
		for _, t := range q.Types {
			if t != "Checkpoint" {
				other = append(other, t)
			}
		}
		if len(other) > 0 {
			or = append(or, `m."type" = ANY(`+b.arg(other)+`::text[]::"ModelType"[])`)
		} else {
			or = append(or, `m."type" != 'Checkpoint'`)
		}
		and = append(and, `(`+strings.Join(or, " OR ")+`)`)
	}
	if q.EarlyAccess {
		and = append(and, `EXISTS (
        SELECT 1 FROM "PaidAccess" pa
        JOIN "ModelVersion" pamv ON pamv.id = pa."entityId"
        WHERE pa."entityType" = 'ModelVersion' AND pamv."modelId" = m.id
          AND pamv.status = 'Published'::"ModelStatus" AND pa."endsAt" > NOW()
      )`)
	}
	if q.PaidAccess {
		and = append(and, `EXISTS (
        SELECT 1 FROM "PaidAccess" pa
        JOIN "ModelVersion" pamv ON pamv.id = pa."entityId"
        WHERE pa."entityType" = 'ModelVersion' AND pamv."modelId" = m.id
          AND pamv.status = 'Published'::"ModelStatus" AND pa."timeframeDays" IS NULL
      )`)
	}
	if q.HidePaid {
		// The OR arm (freePublishedVersionExistsSql) keeps a gated model that has a free version to show.
		and = append(and, `(NOT EXISTS (
        SELECT 1 FROM "PaidAccess" pa
        JOIN "ModelVersion" mv ON mv.id = pa."entityId"
        WHERE `+paidAccessLiveSQL+`
          AND mv."modelId" = m.id
      ) OR `+freePublishedVersionExistsSQL(q.HidePrivate)+`)`)
	}
	if q.OnSale {
		and = append(and, `EXISTS (
        SELECT 1 FROM "ModelVersionSaleItem" si
        JOIN "ModelVersionSale" s ON s.id = si."saleId"
        JOIN "ModelVersion" smv ON smv.id = si."modelVersionId"
        JOIN "PaidAccess" spa ON spa."entityType" = 'ModelVersion' AND spa."entityId" = smv.id
        WHERE smv."modelId" = m.id
          AND smv.status = 'Published'::"ModelStatus"
          AND spa."timeframeDays" IS NULL
          AND s."userId" = m."userId"
          AND s."startsAt" <= NOW() AND s."endsAt" > NOW()
          AND (s."canceledAt" IS NULL OR s."canceledAt" > NOW())
      )`)
	}
	// No availability filter is ported: a non-moderator's feed never holds Private models.
	if !q.IsModerator {
		and = append(and, p+`."availability" != 'Private'::"Availability"`)
	}
	if q.CollectionID != 0 {
		// The semi-join of every sort but Recently Added (ParseWith refuses that one), with
		// getAvailableCollectionItemsFilterForUser's item filter built without `statuses`: accepted
		// items, and for a signed-in viewer also the items they added that are still in review.
		clause := `EXISTS (
        SELECT 1 FROM "CollectionItem" ci
        WHERE ci."modelId" = mm."modelId"
        AND ci."collectionId" = ` + b.arg(q.CollectionID) + `
        AND `
		if q.ViewerID != 0 {
			clause += `(ci."status" = 'ACCEPTED'::"CollectionItemStatus" OR (ci."status" = 'REVIEW'::"CollectionItemStatus" AND ci."addedById" = ` + b.arg(q.ViewerID) + `))`
		} else {
			clause += `ci."status" = 'ACCEPTED'::"CollectionItemStatus"`
		}
		if q.CollectionTagID != 0 {
			clause += `
        AND ci."tagId" = ` + b.arg(q.CollectionTagID)
		}
		and = append(and, clause+`
      )`)
	}
	if len(q.ExcludedUserIDs) > 0 {
		and = append(and, `mm."userId" != ALL(`+b.arg(q.ExcludedUserIDs)+`::int[])`)
	}

	order := orderBy(q.Sort, p)
	fields := parseSortString(order)
	cur, err := b.cursorClauses(fields, q.Cursor)
	if err != nil {
		return SQL{}, err
	}
	if !cur.splittable && cur.strict != "" {
		and = append(and, cur.strict)
	}
	if len(q.FileFormats) > 0 {
		ors := make([]string, len(q.FileFormats))
		for i, f := range q.FileFormats {
			// Interpolated as Node does; ParseWith admits only the constants.modelFileFormats values.
			ors[i] = `mf."metadata" @> '{"format": "` + f + `"}'`
		}
		and = append(and, `EXISTS (
      SELECT 1 FROM "ModelFile" mf
      JOIN "ModelVersion" mv ON mf."modelVersionId" = mv."id" AND mv."modelId" = mm."modelId"
      WHERE mf."modelVersionId" = mv."id"
        AND mf."type" = 'Model'
        AND (`+strings.Join(ors, " OR ")+`)
    )`)
	}
	// `pending` is not ported: the plain level clause.
	and = append(and, `(`+p+`."nsfwLevel" & `+b.arg(q.BrowsingLevel)+`) != 0`)

	var from string
	switch {
	case !useBM: // no base-model filter
		from = `FROM "ModelMetric" mm
      JOIN "Model" m ON m."id" = mm."modelId"`
	case len(q.BaseModels) == 1:
		from = `FROM "ModelBaseModelMetric" mbm
      JOIN "Model" m ON m."id" = mbm."modelId"
      JOIN "ModelMetric" mm ON mm."modelId" = mbm."modelId"`
	case multiDriven:
		from = `FROM "ModelMetric" mm
      JOIN "Model" m ON m."id" = mm."modelId"
      LEFT JOIN LATERAL (
        SELECT
          LEAST(SUM("downloadCount")::int, mm."downloadCount") as "downloadCount",
          LEAST(SUM("thumbsUpCount")::int, mm."thumbsUpCount") as "thumbsUpCount"
        FROM "ModelBaseModelMetric"
        WHERE "modelId" = mm."modelId"
          AND "baseModel" = ANY(` + b.arg(q.BaseModels) + `::text[])
      ) mbm ON true`
	default:
		from = `FROM (
        SELECT "modelId",
          SUM("downloadCount")::int as "downloadCount",
          SUM("thumbsUpCount")::int as "thumbsUpCount",
          SUM("imageCount")::int as "imageCount",
          MIN("status") as "status",
          MIN("nsfwLevel") as "nsfwLevel",
          MIN("availability") as "availability",
          MIN("mode") as "mode",
          MAX("minor"::int)::bool as "minor",
          MAX("poi"::int)::bool as "poi"
        FROM "ModelBaseModelMetric"
        WHERE "baseModel" = ANY(` + b.arg(q.BaseModels) + `::text[])
        GROUP BY "modelId"
      ) mbs
      JOIN "Model" m ON m."id" = mbs."modelId"
      JOIN "ModelMetric" mm ON mm."modelId" = mbs."modelId"
      CROSS JOIN LATERAL (
        SELECT mbs."modelId",
          LEAST(mbs."downloadCount", mm."downloadCount") as "downloadCount",
          LEAST(mbs."thumbsUpCount", mm."thumbsUpCount") as "thumbsUpCount",
          mbs."imageCount", mbs."status", mbs."nsfwLevel", mbs."availability",
          mbs."mode", mbs."minor", mbs."poi"
      ) mbm`
	}

	// The enum and citext columns are read as text, which is what node-postgres hands Node for them.
	sel := p + `."modelId" as "id",
      m."name"::text as "name",
      m."sfwName"::text as "sfwName",
      m."coverImageId",
      m."sfwCoverImageId",
      m."type"::text as "type",
      ` + p + `."minor",
      m."sfwOnly",
      ` + p + `."poi",
      m."nsfw",
      ` + p + `."nsfwLevel",
      ` + p + `."status"::text as "status",
      m."createdAt",
      mm."lastVersionAt",
      m."publishedAt",
      m."locked",
      m."meta",
      ` + p + `."mode"::text as "mode",
      ` + p + `."availability"::text as "availability",
      jsonb_build_object(
        'downloadCount', ` + rankP + `."downloadCount",
        'thumbsUpCount', ` + rankP + `."thumbsUpCount",
        'thumbsDownCount', mm."thumbsDownCount",
        'commentCount', mm."commentCount",
        'collectedCount', mm."collectedCount",
        'tippedAmountCount', mm."tippedAmountCount"
      ) as "rank",
      mm."userId",
      ` + cursorProp(fields) + `::text as "cursorId"`

	limit := b.arg(q.Take + 1)
	where := strings.Join(and, " AND ")
	var text string
	if cur.splittable {
		// Equality first: for DESC head fields its rows sort before the strict branch's, and Append
		// returns the first child's rows first (see getModelsRaw).
		text = `
    (
      SELECT
        ` + sel + `
      ` + from + `
      WHERE
        ` + where + ` AND ` + cur.equality + `
      ORDER BY
        ` + order + `
      LIMIT ` + limit + `
    )
    UNION ALL
    (
      SELECT
        ` + sel + `
      ` + from + `
      WHERE
        ` + where + ` AND ` + cur.strict + `
      ORDER BY
        ` + order + `
      LIMIT ` + limit + `
    )
    LIMIT ` + limit + `
  `
	} else {
		text = `
    SELECT
      ` + sel + `
    ` + from + `
    WHERE
      ` + where + `
    ORDER BY
      ` + order + `
    LIMIT ` + limit + `
  `
	}
	// Bound last, so the clause leaves every other placeholder's number as it was. A split cursor
	// puts the WHERE in both UNION ALL branches: one bind, every occurrence.
	if strings.Contains(text, withheldViewerSlot) {
		text = strings.ReplaceAll(text, withheldViewerSlot, b.arg(q.ViewerID))
	}
	return SQL{Text: text, Args: b.args}, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// uniqueInts is `[...new Set(ids)]`: first-seen order, duplicates dropped.
func uniqueInts(ids []int) []int {
	seen := make(map[int]bool, len(ids))
	out := make([]int, 0, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}
