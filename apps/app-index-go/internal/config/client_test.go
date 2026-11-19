package config

import (
	"strings"
	"testing"
)

func TestNoClientByDefault(t *testing.T) {
	c, err := FromEnv(env(base()))
	if err != nil {
		t.Fatal(err)
	}
	if c.Client != nil {
		t.Fatalf("Client = %+v, want nil (anonymous)", c.Client)
	}
}

func TestClientCredentials(t *testing.T) {
	m := base()
	m["APP_INDEX_CLIENT_ID"] = "6f2a9c1e-4b7d-4e3a-8c5f-1d0e2b3a4c5d"
	m["APP_INDEX_CLIENT_SECRET"] = "sec-9f"
	m["APP_INDEX_TOKEN_URL"] = "https://auth.invalid/api/auth/oauth/token"
	m["APP_INDEX_TOKEN_RESOURCE"] = "https://registry.invalid"
	m["APP_INDEX_TOKEN_SCOPE"] = "AppsRead"
	c, err := FromEnv(env(m))
	if err != nil {
		t.Fatal(err)
	}
	want := Client{ID: "6f2a9c1e-4b7d-4e3a-8c5f-1d0e2b3a4c5d", Secret: "sec-9f", //nolint:gosec // test fixture, not a credential
		TokenURL: "https://auth.invalid/api/auth/oauth/token", Resource: "https://registry.invalid", Scope: "AppsRead"}
	if c.Client == nil || *c.Client != want {
		t.Fatalf("Client = %+v, want %+v", c.Client, want)
	}
}

// A half-configured client is refused at start, never silently anonymous.
func TestClientCredentialsRefusesHalfAConfiguration(t *testing.T) {
	cases := []struct {
		name string
		set  map[string]string
		want string
	}{
		{"no secret", map[string]string{"APP_INDEX_CLIENT_ID": "id-1", "APP_INDEX_TOKEN_URL": "https://auth.invalid/t"}, "APP_INDEX_CLIENT_SECRET is required"}, //nolint:gosec // test fixture, not a credential
		{"no token url", map[string]string{"APP_INDEX_CLIENT_ID": "id-1", "APP_INDEX_CLIENT_SECRET": "sec-9f"}, "APP_INDEX_TOKEN_URL must be"},
		{"bad token url", map[string]string{"APP_INDEX_CLIENT_ID": "id-1", "APP_INDEX_CLIENT_SECRET": "sec-9f", "APP_INDEX_TOKEN_URL": "ftp://auth.invalid"}, "APP_INDEX_TOKEN_URL must be"}, //nolint:gosec // test fixture, not a credential
		{"secret without id", map[string]string{"APP_INDEX_CLIENT_SECRET": "sec-9f"}, "APP_INDEX_CLIENT_ID is required"},
		{"resource without id", map[string]string{"APP_INDEX_TOKEN_RESOURCE": "https://r.invalid"}, "APP_INDEX_CLIENT_ID is required"},                                                                                     //nolint:gosec // test fixture, not a credential
		{"client and static token", map[string]string{"APP_INDEX_CLIENT_ID": "id-1", "APP_INDEX_CLIENT_SECRET": "sec-9f", "APP_INDEX_TOKEN_URL": "https://auth.invalid/t", "APP_INDEX_REGISTRY_TOKEN": "tok"}, "not both"}, //nolint:gosec // test fixture, not a credential
	}
	for _, tc := range cases {
		m := base()
		for k, v := range tc.set {
			m[k] = v
		}
		_, err := FromEnv(env(m))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: err %v, want one naming %q", tc.name, err, tc.want)
		}
		if strings.Contains(err.Error(), "sec-9f") {
			t.Fatalf("%s: error echoes the secret: %v", tc.name, err)
		}
	}
}
