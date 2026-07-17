// Package token implements API tokens for the agent: long-lived, user-generated
// bearer credentials (distinct from the web UI's Supabase JWT) that carry an
// expiry and a set of scopes. Secrets are shown once at creation and stored only
// as a SHA-256 hash. Persistence is a single JSON file in the config dir.
package token

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Prefix is the human-visible marker so a token is recognisable in logs/headers.
const Prefix = "sot_"

// Token is the stored record. The secret itself is never persisted - only Hash.
type Token struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Owner    string   `json:"owner"` // creator email
	Scopes   []string `json:"scopes"`
	Preview  string   `json:"preview"` // e.g. "sot_ab12…" for display
	Hash     string   `json:"hash"`    // sha256(secret) hex; stripped from API responses
	Created  int64    `json:"created"`
	Expires  int64    `json:"expires"` // unix seconds; 0 = never
	LastUsed int64    `json:"lastUsed"`
	Revoked  bool     `json:"revoked"`
}

// Public returns a copy safe to serialise to API clients (no hash).
func (t Token) Public() Token {
	t.Hash = ""
	return t
}

// Expired reports whether the token is past its expiry.
func (t Token) Expired() bool {
	return t.Expires != 0 && time.Now().Unix() >= t.Expires
}

// Store is a mutex-guarded, file-backed collection of tokens.
type Store struct {
	Path string
	mu   sync.Mutex
}

func (s *Store) loadLocked() ([]Token, error) {
	b, err := os.ReadFile(s.Path)
	if os.IsNotExist(err) {
		return []Token{}, nil
	}
	if err != nil {
		return nil, err
	}
	var toks []Token
	if err := json.Unmarshal(b, &toks); err != nil {
		return nil, fmt.Errorf("parse %s: %w", s.Path, err)
	}
	return toks, nil
}

func (s *Store) saveLocked(toks []Token) error {
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o750); err != nil {
		return err
	}
	b, err := json.MarshalIndent(toks, "", "  ")
	if err != nil {
		return err
	}
	// 0600: the file holds token hashes.
	return os.WriteFile(s.Path, b, 0o600)
}

// List returns tokens visible to the caller. Admins (all=true) see everything;
// otherwise only tokens owned by owner. Hashes are stripped.
func (s *Store) List(owner string, all bool) ([]Token, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	toks, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	out := make([]Token, 0, len(toks))
	for _, t := range toks {
		if all || t.Owner == owner {
			out = append(out, t.Public())
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created > out[j].Created })
	return out, nil
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func hashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// Create mints a new token, returning the one-time secret and the stored record.
func (s *Store) Create(name, owner string, scopes []string, expires int64) (secret string, tok Token, err error) {
	if name == "" {
		return "", Token{}, fmt.Errorf("token name is required")
	}
	if len(scopes) == 0 {
		return "", Token{}, fmt.Errorf("at least one scope is required")
	}
	raw := make([]byte, 24)
	if _, err = rand.Read(raw); err != nil {
		return "", Token{}, err
	}
	secret = Prefix + base64.RawURLEncoding.EncodeToString(raw)

	s.mu.Lock()
	defer s.mu.Unlock()
	toks, err := s.loadLocked()
	if err != nil {
		return "", Token{}, err
	}
	tok = Token{
		ID:      newID(),
		Name:    name,
		Owner:   owner,
		Scopes:  scopes,
		Preview: secret[:len(Prefix)+4] + "…",
		Hash:    hashSecret(secret),
		Created: time.Now().Unix(),
		Expires: expires,
	}
	toks = append(toks, tok)
	if err = s.saveLocked(toks); err != nil {
		return "", Token{}, err
	}
	return secret, tok.Public(), nil
}

// Revoke deletes a token. Non-admins may only revoke their own.
func (s *Store) Revoke(id, owner string, isAdmin bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	toks, err := s.loadLocked()
	if err != nil {
		return err
	}
	idx := -1
	for i, t := range toks {
		if t.ID == id {
			idx = i
			break
		}
	}
	if idx == -1 {
		return fmt.Errorf("token not found")
	}
	if !isAdmin && toks[idx].Owner != owner {
		return fmt.Errorf("not your token")
	}
	toks = append(toks[:idx], toks[idx+1:]...)
	return s.saveLocked(toks)
}

// Verify matches a presented secret against the store. On success it returns the
// token (with hash stripped) and bumps LastUsed (throttled to once/minute to
// avoid a disk write on every request).
func (s *Store) Verify(secret string) (Token, bool) {
	want := hashSecret(secret)
	s.mu.Lock()
	defer s.mu.Unlock()
	toks, err := s.loadLocked()
	if err != nil {
		return Token{}, false
	}
	for i := range toks {
		if subtle.ConstantTimeCompare([]byte(toks[i].Hash), []byte(want)) != 1 {
			continue
		}
		if toks[i].Revoked || toks[i].Expired() {
			return Token{}, false
		}
		now := time.Now().Unix()
		if now-toks[i].LastUsed > 60 {
			toks[i].LastUsed = now
			_ = s.saveLocked(toks)
		}
		return toks[i].Public(), true
	}
	return Token{}, false
}
