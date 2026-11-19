package v1models

import (
	"strconv"
	"strings"
)

// sqlFrag is a Prisma.Sql in the making: literal text and bound values, numbered `$n` in order of
// appearance when the statement is built. A fragment used twice binds its values twice, as Prisma's
// flattening does, so the text and the argument list come out as Node's.
type sqlFrag struct {
	parts []sqlPart
}

type sqlPart struct {
	text  string
	param any
	frag  *sqlFrag
	kind  uint8 // 0 text, 1 param, 2 nested fragment
}

func (s *sqlFrag) raw(text string) *sqlFrag {
	s.parts = append(s.parts, sqlPart{text: text})
	return s
}

func (s *sqlFrag) arg(v any) *sqlFrag {
	s.parts = append(s.parts, sqlPart{param: v, kind: 1})
	return s
}

func (s *sqlFrag) sub(f *sqlFrag) *sqlFrag {
	if f != nil {
		s.parts = append(s.parts, sqlPart{frag: f, kind: 2})
	}
	return s
}

// sqlRaw is Prisma.raw.
func sqlRaw(text string) *sqlFrag { return (&sqlFrag{}).raw(text) }

// sqlJoin is Prisma.join over fragments.
func sqlJoin(frags []*sqlFrag, sep string) *sqlFrag {
	out := &sqlFrag{}
	for i, f := range frags {
		if i > 0 {
			out.raw(sep)
		}
		out.sub(f)
	}
	return out
}

// sqlJoinArgs is Prisma.join over values: one bound value each.
func sqlJoinArgs[T any](vals []T, sep string) *sqlFrag {
	out := &sqlFrag{}
	for i, v := range vals {
		if i > 0 {
			out.raw(sep)
		}
		out.arg(v)
	}
	return out
}

// build numbers the bound values and returns the statement text and its arguments.
func (s *sqlFrag) build() (string, []any) {
	var b strings.Builder
	var args []any
	s.write(&b, &args)
	return b.String(), args
}

func (s *sqlFrag) write(b *strings.Builder, args *[]any) {
	for _, p := range s.parts {
		switch p.kind {
		case 0:
			b.WriteString(p.text)
		case 1:
			*args = append(*args, p.param)
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(len(*args)))
		case 2:
			p.frag.write(b, args)
		}
	}
}

// NormalizeSQL collapses every whitespace run to one space and trims the ends: two statements built
// from the same template differ only in their indentation, which the comparison ignores.
func NormalizeSQL(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
