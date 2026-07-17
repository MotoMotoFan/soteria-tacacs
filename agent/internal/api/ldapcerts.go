package api

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// LDAP TLS material lives in the shared tacacs-config volume, which is mounted
// at /etc/tac_plus-ng in BOTH soteria-agent and soteria-tacacs. So one uploaded
// bundle serves the agent's Go LDAP client (web UI sign-in) and the MAVIS perl
// backend (TACACS+ device auth) at the same absolute path.
// The canonical absolute paths live in tacconfig (LdapCAPath etc.) because the
// mavis config renderer needs them too.
const ldapCertSubdir = "tls/ldap"

// ldapCertFiles maps the API name to its filename and whether it is a private
// key (which is never echoed back and gets stricter permissions).
var ldapCertFiles = map[string]struct {
	file  string
	isKey bool
}{
	"ca":          {"ca.crt", false},
	"client-cert": {"client.crt", false},
	"client-key":  {"client.key", true},
}

func (s *Server) ldapCertDir() string { return filepath.Join(s.Store.Dir, filepath.FromSlash(ldapCertSubdir)) }

// ldapCertInfo is the per-file status returned to the UI.
type ldapCertInfo struct {
	Name    string `json:"name"`
	Present bool   `json:"present"`
	// Certificate details (absent for the private key).
	Subject   string `json:"subject,omitempty"`
	Issuer    string `json:"issuer,omitempty"`
	NotBefore string `json:"notBefore,omitempty"`
	NotAfter  string `json:"notAfter,omitempty"`
	Expired   bool   `json:"expired,omitempty"`
	Error     string `json:"error,omitempty"`
}

// parseCertFile reads a PEM certificate and summarises it.
func parseCertFile(path string) ldapCertInfo {
	info := ldapCertInfo{Present: true}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ldapCertInfo{Present: false}
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		info.Error = "not a valid PEM file"
		return info
	}
	crt, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		info.Error = "not a valid certificate: " + err.Error()
		return info
	}
	info.Subject = crt.Subject.String()
	info.Issuer = crt.Issuer.String()
	info.NotBefore = crt.NotBefore.UTC().Format(time.RFC3339)
	info.NotAfter = crt.NotAfter.UTC().Format(time.RFC3339)
	info.Expired = time.Now().After(crt.NotAfter)
	return info
}

// getLdapCerts reports which parts of the LDAP TLS bundle are installed.
func (s *Server) getLdapCerts(w http.ResponseWriter, _ *http.Request) {
	out := make([]ldapCertInfo, 0, len(ldapCertFiles))
	for _, name := range []string{"ca", "client-cert", "client-key"} {
		meta := ldapCertFiles[name]
		path := filepath.Join(s.ldapCertDir(), meta.file)
		var info ldapCertInfo
		if meta.isKey {
			// Never parse or echo key material; just report presence.
			_, err := os.Stat(path)
			info = ldapCertInfo{Present: err == nil}
		} else {
			info = parseCertFile(path)
		}
		info.Name = name
		out = append(out, info)
	}
	writeJSON(w, http.StatusOK, out)
}

// putLdapCert installs one PEM file of the bundle. Certificates are validated
// by parsing; the key is validated by pairing it with client.crt when present.
func (s *Server) putLdapCert(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	meta, ok := ldapCertFiles[name]
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Errorf("unknown certificate %q (want ca, client-cert or client-key)", name))
		return
	}
	var body struct {
		PEM string `json:"pem"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	raw := []byte(strings.TrimSpace(body.PEM) + "\n")
	block, _ := pem.Decode(raw)
	if block == nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("not a valid PEM file"))
		return
	}
	if meta.isKey {
		if !strings.Contains(block.Type, "PRIVATE KEY") {
			writeError(w, http.StatusBadRequest, fmt.Errorf("expected a PRIVATE KEY PEM block, got %q", block.Type))
			return
		}
	} else if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("not a valid certificate: %w", err))
		return
	}

	if err := os.MkdirAll(s.ldapCertDir(), 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	perm := os.FileMode(0o644)
	if meta.isKey {
		perm = 0o600
	}
	path := filepath.Join(s.ldapCertDir(), meta.file)
	if err := os.WriteFile(path, raw, perm); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// If both halves of the client pair are present they must match, otherwise
	// every TLS handshake would fail later with a confusing error.
	crt := filepath.Join(s.ldapCertDir(), ldapCertFiles["client-cert"].file)
	key := filepath.Join(s.ldapCertDir(), ldapCertFiles["client-key"].file)
	if fileExists(crt) && fileExists(key) {
		if _, err := tls.LoadX509KeyPair(crt, key); err != nil {
			_ = os.Remove(path) // roll back the file we just wrote
			writeError(w, http.StatusBadRequest, fmt.Errorf("client certificate and key do not match: %w", err))
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "name": name})
}

// deleteLdapCert removes one PEM file of the bundle.
func (s *Server) deleteLdapCert(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	meta, ok := ldapCertFiles[name]
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Errorf("unknown certificate %q", name))
		return
	}
	if err := os.Remove(filepath.Join(s.ldapCertDir(), meta.file)); err != nil && !os.IsNotExist(err) {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "removed", "name": name})
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// ldapTLSPaths returns the cert paths that exist, for wiring into an
// ldapauth.Config (empty string when the file isn't installed).
func (s *Server) ldapTLSPaths() (ca, clientCert, clientKey string) {
	d := s.ldapCertDir()
	if p := filepath.Join(d, "ca.crt"); fileExists(p) {
		ca = p
	}
	if p := filepath.Join(d, "client.crt"); fileExists(p) {
		clientCert = p
	}
	if p := filepath.Join(d, "client.key"); fileExists(p) {
		clientKey = p
	}
	return ca, clientCert, clientKey
}
