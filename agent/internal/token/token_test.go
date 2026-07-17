package token

import (
	"path/filepath"
	"testing"
	"time"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	return &Store{Path: filepath.Join(t.TempDir(), ".agent-tokens.json")}
}

func TestCreateAndVerify(t *testing.T) {
	s := newStore(t)
	secret, tok, err := s.Create("ci", "alice@example.com", []string{"devices:read"}, 0)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if secret[:len(Prefix)] != Prefix {
		t.Fatalf("secret missing prefix: %q", secret)
	}
	if tok.Hash != "" {
		t.Fatalf("public token leaked hash")
	}
	got, ok := s.Verify(secret)
	if !ok {
		t.Fatalf("verify failed for valid secret")
	}
	if got.Owner != "alice@example.com" || !hasScopeTest(got.Scopes, "devices:read") {
		t.Fatalf("verify returned wrong token: %+v", got)
	}
	if _, ok := s.Verify("sot_bogus"); ok {
		t.Fatalf("verify accepted a bogus secret")
	}
}

func TestExpiredAndRevoked(t *testing.T) {
	s := newStore(t)
	// Already expired.
	exp, _, err := s.Create("old", "a@x", []string{"logs:read"}, time.Now().Add(-time.Hour).Unix())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Verify(exp); ok {
		t.Fatalf("verify accepted an expired token")
	}

	// Revoked.
	sec, tok, err := s.Create("live", "a@x", []string{"logs:read"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Verify(sec); !ok {
		t.Fatalf("valid token should verify before revoke")
	}
	if err := s.Revoke(tok.ID, "a@x", false); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, ok := s.Verify(sec); ok {
		t.Fatalf("verify accepted a revoked token")
	}
}

func TestRevokeOwnership(t *testing.T) {
	s := newStore(t)
	_, tok, _ := s.Create("mine", "owner@x", []string{"logs:read"}, 0)
	if err := s.Revoke(tok.ID, "someone@else", false); err == nil {
		t.Fatalf("non-owner (non-admin) must not revoke another user's token")
	}
	if err := s.Revoke(tok.ID, "someone@else", true); err != nil {
		t.Fatalf("admin should revoke any token: %v", err)
	}
}

func TestListScoping(t *testing.T) {
	s := newStore(t)
	s.Create("a1", "alice@x", []string{"logs:read"}, 0)
	s.Create("b1", "bob@x", []string{"logs:read"}, 0)
	mine, _ := s.List("alice@x", false)
	if len(mine) != 1 || mine[0].Owner != "alice@x" {
		t.Fatalf("non-admin list should show only own tokens, got %+v", mine)
	}
	all, _ := s.List("alice@x", true)
	if len(all) != 2 {
		t.Fatalf("admin list should show all tokens, got %d", len(all))
	}
}

func hasScopeTest(scopes []string, want string) bool {
	for _, s := range scopes {
		if s == want {
			return true
		}
	}
	return false
}
