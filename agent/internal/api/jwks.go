package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"sync"
	"time"
)

// jwksCache fetches and caches the ES256 public keys (JWKS) that GoTrue signs
// user access tokens with. Modern Supabase uses asymmetric (ES256) signing keys
// exposed at /auth/v1/.well-known/jwks.json, keyed by `kid`.
type jwksCache struct {
	url     string
	mu      sync.Mutex
	keys    map[string]*ecdsa.PublicKey
	fetched time.Time
}

// NewJWKS returns a JWKS cache for the given URL, or nil if url is empty.
func NewJWKS(url string) *jwksCache {
	if url == "" {
		return nil
	}
	return &jwksCache{url: url, keys: map[string]*ecdsa.PublicKey{}}
}

var jwksClient = &http.Client{Timeout: 5 * time.Second}

// key returns the public key for kid, refreshing the JWKS if it is unknown
// (rate-limited so an unknown/forged kid can't trigger a fetch per request).
func (c *jwksCache) key(kid string) *ecdsa.PublicKey {
	c.mu.Lock()
	defer c.mu.Unlock()
	if k, ok := c.keys[kid]; ok {
		return k
	}
	if time.Since(c.fetched) > 30*time.Second {
		c.refreshLocked()
	}
	return c.keys[kid]
}

func (c *jwksCache) refreshLocked() {
	resp, err := jwksClient.Get(c.url)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	var doc struct {
		Keys []struct {
			Kty string `json:"kty"`
			Crv string `json:"crv"`
			Kid string `json:"kid"`
			X   string `json:"x"`
			Y   string `json:"y"`
		} `json:"keys"`
	}
	if json.NewDecoder(resp.Body).Decode(&doc) != nil {
		return
	}
	next := map[string]*ecdsa.PublicKey{}
	for _, k := range doc.Keys {
		if k.Kty != "EC" || (k.Crv != "" && k.Crv != "P-256") {
			continue
		}
		xb, e1 := base64.RawURLEncoding.DecodeString(k.X)
		yb, e2 := base64.RawURLEncoding.DecodeString(k.Y)
		if e1 != nil || e2 != nil {
			continue
		}
		next[k.Kid] = &ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(xb),
			Y:     new(big.Int).SetBytes(yb),
		}
	}
	if len(next) > 0 {
		c.keys = next
		c.fetched = time.Now()
	}
}
