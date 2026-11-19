package main

import (
	"io"
	"log/slog"
	"strings"
	"testing"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func clearDB(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "DATABASE_REPLICA_URL", "DATABASE_URL"} {
		t.Setenv(k, "")
	}
}

func TestRunNeedsADatabase(t *testing.T) {
	clearDB(t)
	if err := run(quiet()); err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Fatalf("err = %v, want the missing database URL named", err)
	}
}

// An unparsable URL is refused without echoing it (it holds the password).
func TestRunRefusesABadDatabaseURL(t *testing.T) {
	clearDB(t)
	t.Setenv("DATABASE_URL", "postgres://user:hunter2@db.invalid:notaport/app")
	err := run(quiet())
	if err == nil || strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("err = %v, want an error that does not echo the URL", err)
	}
}
