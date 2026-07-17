package api

import (
	"crypto/ecdsa"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"strings"
	"time"
)

func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return "", false
	}
	return strings.TrimPrefix(h, "Bearer "), true
}

type jwtClaims struct {
	Exp         int64  `json:"exp"`
	Email       string `json:"email"`
	AppMetadata struct {
		Role   string   `json:"role"`
		Scopes []string `json:"scopes"`
	} `json:"app_metadata"`
}

// verifyJWT validates a Supabase GoTrue access token and returns its claims.
// Supabase signs user tokens with ES256 (asymmetric keys from the JWKS); older
// setups / the anon+service keys use HS256 against the shared secret. Both are
// supported. The frontend's admin ("Super User") marker is app_metadata.role.
func (s *Server) verifyJWT(token string) (*jwtClaims, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, false
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(headerJSON, &header) != nil {
		return nil, false
	}
	signing := parts[0] + "." + parts[1]
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, false
	}

	switch header.Alg {
	case "HS256":
		if len(s.JWTSecret) == 0 {
			return nil, false
		}
		mac := hmac.New(sha256.New, s.JWTSecret)
		mac.Write([]byte(signing))
		if !hmac.Equal(sig, mac.Sum(nil)) {
			return nil, false
		}
	case "ES256":
		if s.JWKS == nil || len(sig) != 64 {
			return nil, false
		}
		pub := s.JWKS.key(header.Kid)
		if pub == nil {
			return nil, false
		}
		digest := sha256.Sum256([]byte(signing))
		r := new(big.Int).SetBytes(sig[:32])
		ss := new(big.Int).SetBytes(sig[32:])
		if !ecdsa.Verify(pub, digest[:], r, ss) {
			return nil, false
		}
	default:
		return nil, false
	}

	var claims jwtClaims
	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(payloadJSON, &claims) != nil {
		return nil, false
	}
	if claims.Exp != 0 && time.Now().Unix() >= claims.Exp {
		return nil, false
	}
	return &claims, true
}
