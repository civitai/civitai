package tracing

import (
	"context"
	"errors"
	"hash/fnv"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// The store span attributes. Statement identity only, never a value: the operation keyword and a
// hash of the SQL text (a stable id per statement), the Redis command NAME, never its keys or args
// (a key can hold a user or session id).
var (
	attrDBSystem    = attribute.Key("db.system.name")
	attrDBOperation = attribute.Key("db.operation.name")
	attrDBQueryHash = attribute.Key("db.query.hash")
	attrDBBatchSize = attribute.Key("db.operation.batch.size")
	attrRedisClient = attribute.Key("feed_go.redis")
	attrErrorType   = attribute.Key("error.type")
	attrRowsAff     = attribute.Key("db.response.rows_affected")
	attrRowsRet     = attribute.Key("db.response.returned_rows")
)

// pgxSpanKey holds the span TraceQueryStart started, for TraceQueryEnd.
type pgxSpanKey struct{}

// PgxTracer is a pgx.QueryTracer: one client span per Query/QueryRow/Exec, named `pgx <OPERATION>`,
// started only under a RECORDING span (an unsampled request pays one context read). The rows of a
// query are not spanned.
type PgxTracer struct {
	Tracer trace.Tracer
}

var _ pgx.QueryTracer = PgxTracer{}

// TraceQueryStart starts the query's span.
func (t PgxTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	if !trace.SpanFromContext(ctx).IsRecording() {
		return ctx
	}
	op := Operation(d.SQL)
	ctx, span := t.Tracer.Start(ctx, "pgx "+op, trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
		attrDBSystem.String("postgresql"), attrDBOperation.String(op), attrDBQueryHash.String(QueryHash(d.SQL))))
	return context.WithValue(ctx, pgxSpanKey{}, span)
}

// TraceQueryEnd ends it: an error is the status (its class, fallback.Class) and error.type, never its
// text (a Postgres error can quote a value).
func (t PgxTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryEndData) {
	span, ok := ctx.Value(pgxSpanKey{}).(trace.Span)
	if !ok {
		return
	}
	if d.Err != nil {
		span.SetStatus(codes.Error, fallback.Class(d.Err))
		span.SetAttributes(attrErrorType.String(fallback.Type(d.Err)))
	} else {
		span.SetAttributes(attrRowsAff.Int64(d.CommandTag.RowsAffected()))
	}
	span.End()
}

// Operation is the SQL statement's first keyword, upper-cased (SELECT, WITH, …), after leading blanks
// and comments; OTHER when it does not start with a letter. At most 16 letters: a keyword, never a
// value.
func Operation(sql string) string {
	i := 0
	for i < len(sql) {
		switch {
		case sql[i] == ' ' || sql[i] == '\t' || sql[i] == '\n' || sql[i] == '\r':
			i++
		case i+1 < len(sql) && sql[i] == '-' && sql[i+1] == '-':
			for i < len(sql) && sql[i] != '\n' {
				i++
			}
		case i+1 < len(sql) && sql[i] == '/' && sql[i+1] == '*':
			end := i + 2
			for end+1 < len(sql) && (sql[end] != '*' || sql[end+1] != '/') {
				end++
			}
			i = end + 2
		default:
			j := i
			for j < len(sql) && j-i < 16 && isLetter(sql[j]) {
				j++
			}
			if j == i {
				return "OTHER"
			}
			b := []byte(sql[i:j])
			for k, c := range b {
				if c >= 'a' && c <= 'z' {
					b[k] = c - 'a' + 'A'
				}
			}
			return string(b)
		}
	}
	return "OTHER"
}

func isLetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

// QueryHash is a stable id of a statement's text: FNV-1a 64, hex. The SQL is this service's own
// (values are bind parameters), so the hash identifies the statement and carries nothing else.
func QueryHash(sql string) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(sql))
	return strconv.FormatUint(h.Sum64(), 16)
}

// RedisHook is a go-redis hook: one client span per command (`redis <name>`) and one per pipeline
// (`redis pipeline`, with its command count), started only under a RECORDING span. Client names the
// client (cache | sys). Only the command name is recorded, never keys or arguments; redis.Nil (a miss)
// is not an error.
type RedisHook struct {
	Tracer trace.Tracer
	Client string
}

var _ redis.Hook = RedisHook{}

// DialHook passes dials through.
func (h RedisHook) DialHook(next redis.DialHook) redis.DialHook { return next }

// ProcessHook spans one command.
func (h RedisHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if !trace.SpanFromContext(ctx).IsRecording() {
			return next(ctx, cmd)
		}
		name := fallback.Token(cmd.Name())
		ctx, span := h.Tracer.Start(ctx, "redis "+name, trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
			attrDBSystem.String("redis"), attrDBOperation.String(name), attrRedisClient.String(h.Client)))
		err := next(ctx, cmd)
		endRedis(span, err)
		return err
	}
}

// ProcessPipelineHook spans one pipeline (not its commands).
func (h RedisHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		if !trace.SpanFromContext(ctx).IsRecording() {
			return next(ctx, cmds)
		}
		ctx, span := h.Tracer.Start(ctx, "redis pipeline", trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
			attrDBSystem.String("redis"), attrDBOperation.String("pipeline"), attrDBBatchSize.Int(len(cmds)),
			attrRedisClient.String(h.Client)))
		err := next(ctx, cmds)
		endRedis(span, err)
		return err
	}
}

func endRedis(span trace.Span, err error) {
	if err != nil && !errors.Is(err, redis.Nil) {
		span.SetStatus(codes.Error, fallback.Class(err))
		span.SetAttributes(attrErrorType.String(fallback.Type(err)))
	}
	span.End()
}

// chSpanKey holds the span ClickHouseTracer.QueryStart started, for QueryEnd.
type chSpanKey struct{}

// ClickHouseTracer is a chread.Tracer: one client span per ClickHouse read (`clickhouse query`, its
// operation keyword as db.operation.name), started only under a RECORDING span (an unsampled request
// pays one context read). No text of the query is recorded, not even a hash: the metrics read inlines
// its ids into the SQL, so a hash would be one value per id list. Nor the request URL (it carries
// the query) or the login.
type ClickHouseTracer struct {
	Tracer trace.Tracer
}

var _ chread.Tracer = ClickHouseTracer{}

// QueryStart starts the read's span.
func (t ClickHouseTracer) QueryStart(ctx context.Context, sql string) context.Context {
	if !trace.SpanFromContext(ctx).IsRecording() {
		return ctx
	}
	ctx, span := t.Tracer.Start(ctx, "clickhouse query", trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
		attrDBSystem.String("clickhouse"), attrDBOperation.String(Operation(sql))))
	return context.WithValue(ctx, chSpanKey{}, span)
}

// QueryEnd ends it: an error (a refused slot, a timeout, a ClickHouse exception) is the status (its
// class, fallback.Class) and error.type, never its text (a ClickHouse exception quotes the query);
// else the rows returned.
func (t ClickHouseTracer) QueryEnd(ctx context.Context, rows int, err error) {
	span, ok := ctx.Value(chSpanKey{}).(trace.Span)
	if !ok {
		return
	}
	if err != nil {
		span.SetStatus(codes.Error, fallback.Class(err))
		span.SetAttributes(attrErrorType.String(fallback.Type(err)))
	} else {
		span.SetAttributes(attrRowsRet.Int(rows))
	}
	span.End()
}
