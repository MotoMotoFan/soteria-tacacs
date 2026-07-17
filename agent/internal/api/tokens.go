package api

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// ---------------------------------------------------------------------------
// Caller identity (set by the auth middleware, read by handlers)
// ---------------------------------------------------------------------------

type ctxKey int

const identityCtxKey ctxKey = iota

// identity is the authenticated caller: either a web-UI user (Supabase JWT) or
// an API token. Web users have unrestricted API access (admin sub-checks still
// apply); token callers are limited to their scopes.
type identity struct {
	IsUser bool
	Email  string
	Role   string
	Scopes []string
}

func withIdentity(ctx context.Context, id *identity) context.Context {
	return context.WithValue(ctx, identityCtxKey, id)
}

func identityFrom(ctx context.Context) *identity {
	id, _ := ctx.Value(identityCtxKey).(*identity)
	return id
}

func hasScope(scopes []string, needed string) bool {
	for _, s := range scopes {
		if s == needed {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Scope catalog (one entry per token-scopable endpoint; drives the UI + OpenAPI)
// ---------------------------------------------------------------------------

type scopeInfo struct {
	Scope       string `json:"scope"`
	Method      string `json:"method"`
	Path        string `json:"path"`
	Description string `json:"description"`
}

func (s *Server) validScopes() map[string]bool {
	set := map[string]bool{}
	for _, sc := range s.scopeCatalog {
		set[sc.Scope] = true
	}
	return set
}

func (s *Server) listScopes(w http.ResponseWriter, r *http.Request) {
	if id := identityFrom(r.Context()); id == nil || !id.IsUser {
		writeError(w, http.StatusForbidden, fmt.Errorf("token management requires a web session"))
		return
	}
	writeJSON(w, http.StatusOK, s.scopeCatalog)
}

// ---------------------------------------------------------------------------
// Token management (web-session only; API tokens cannot mint or list tokens)
// ---------------------------------------------------------------------------

func (s *Server) requireUser(w http.ResponseWriter, r *http.Request) (*identity, bool) {
	id := identityFrom(r.Context())
	if id == nil || !id.IsUser {
		writeError(w, http.StatusForbidden, fmt.Errorf("token management requires a web session, not an API token"))
		return nil, false
	}
	return id, true
}

func (s *Server) listTokens(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	toks, err := s.Tokens.List(id.Email, id.Role == "admin")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, toks)
}

func (s *Server) createToken(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	var body struct {
		Name          string   `json:"name"`
		Scopes        []string `json:"scopes"`
		ExpiresInDays int      `json:"expiresInDays"` // 0 = never
		ExpiresAt     int64    `json:"expiresAt"`     // optional explicit unix seconds
	}
	if !decodeBody(w, r, &body) {
		return
	}
	valid := s.validScopes()
	for _, sc := range body.Scopes {
		if !valid[sc] {
			writeError(w, http.StatusBadRequest, fmt.Errorf("unknown scope %q", sc))
			return
		}
	}
	var expires int64
	switch {
	case body.ExpiresAt > 0:
		expires = body.ExpiresAt
	case body.ExpiresInDays > 0:
		expires = time.Now().Add(time.Duration(body.ExpiresInDays) * 24 * time.Hour).Unix()
	}
	secret, tok, err := s.Tokens.Create(body.Name, id.Email, body.Scopes, expires)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	// secret is returned ONCE; it is never retrievable again.
	writeJSON(w, http.StatusCreated, map[string]any{"token": tok, "secret": secret})
}

func (s *Server) revokeToken(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := s.Tokens.Revoke(r.PathValue("id"), id.Email, id.Role == "admin"); err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

// verifyToken resolves an API-token secret to a caller identity (scope checks
// happen later in authorize).
func (s *Server) verifyToken(secret string) (*identity, bool) {
	tok, valid := s.Tokens.Verify(secret)
	if !valid {
		return nil, false
	}
	return &identity{IsUser: false, Email: tok.Owner, Scopes: tok.Scopes}, true
}
