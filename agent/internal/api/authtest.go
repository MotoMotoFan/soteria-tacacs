package api

import (
	"net/http"
	"strings"

	"github.com/Pathfinder-Insights/soteria-agent/internal/ldapauth"
	"github.com/Pathfinder-Insights/soteria-agent/internal/model"
	"github.com/Pathfinder-Insights/soteria-agent/internal/store"
	"github.com/Pathfinder-Insights/soteria-agent/internal/tacconfig"
)

type ldapTestBody struct {
	Config struct {
		Host         string `json:"host"`
		Port         string `json:"port"`
		UseTls       bool   `json:"useTls"`
		BaseDn       string `json:"baseDn"`
		BindDn       string `json:"bindDn"`
		BindPassword string `json:"bindPassword"`
		UserFilter   string `json:"userFilter"`
		GroupBaseDn  string `json:"groupBaseDn"`
		SyncGroups   bool   `json:"syncGroups"`
		ServerType   string `json:"serverType"`
		GroupFilter  string `json:"groupFilter"`
		MemberAttr   string `json:"memberAttr"`
		TLSMode      string `json:"tlsMode"`
		TLSVerify    bool   `json:"tlsVerify"`
	} `json:"config"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// cfg builds the client config. TLS material always comes from the shared
// bundle on disk (never from the request body), so keys are never sent over
// the wire.
func (s *Server) cfg(b ldapTestBody) ldapauth.Config {
	ca, crt, key := s.ldapTLSPaths()
	return ldapauth.Config{
		Host: b.Config.Host, Port: b.Config.Port, UseTLS: b.Config.UseTls,
		BaseDN: b.Config.BaseDn, BindDN: b.Config.BindDn, BindPassword: b.Config.BindPassword,
		UserFilter: b.Config.UserFilter, GroupBaseDN: b.Config.GroupBaseDn,
		ServerType: b.Config.ServerType, GroupFilter: b.Config.GroupFilter, MemberAttr: b.Config.MemberAttr,
		TLSMode: b.Config.TLSMode, TLSVerify: b.Config.TLSVerify,
		CAFile: ca, ClientCertFile: crt, ClientKeyFile: key,
	}
}

func (s *Server) ldapTestConnection(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	var body ldapTestBody
	if !decodeBody(w, r, &body) {
		return
	}
	msg, err := ldapauth.TestConnection(s.cfg(body))
	if err != nil {
		writeError(w, http.StatusFailedDependency, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": msg})
}

func (s *Server) ldapTestUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	var body ldapTestBody
	if !decodeBody(w, r, &body) {
		return
	}
	res, err := ldapauth.TestUser(s.cfg(body), body.Username, body.Password)
	if err != nil {
		writeError(w, http.StatusFailedDependency, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// mavisLdapConfig builds an ldapauth.Config from the TACACS+ MAVIS server
// settings (as edited on the TACACS Settings page). A blank bind password falls
// back to the one stored in 03-mavis.cfg, matching putSettings, so the operator
// can test without re-typing the secret.
func (s *Server) mavisLdapConfig(in model.ServerSettings) ldapauth.Config {
	pass := in.LdapPassword
	if strings.TrimSpace(pass) == "" {
		if src, err := s.Store.ReadEffective(store.MavisFile); err == nil {
			pass = tacconfig.MavisPassword(src)
		}
	}
	host, port, useTLS := parseLdapHost(in.LdapHosts)
	ca, crt, key := s.ldapTLSPaths()
	return ldapauth.Config{
		Host: host, Port: port, UseTLS: useTLS,
		BaseDN: in.LdapBase, BindDN: in.LdapUser, BindPassword: pass,
		UserFilter: in.LdapFilter, GroupBaseDN: in.LdapBaseGroup,
		ServerType: in.LdapServerType, GroupFilter: in.LdapFilterGroup,
		MemberAttr: in.LdapTacMember, ConnectTimeout: in.LdapConnectTimeout,
		TLSMode: in.LdapTLSMode, TLSVerify: in.LdapTLSVerify,
		CAFile: ca, ClientCertFile: crt, ClientKeyFile: key,
	}
}

type mavisTestBody struct {
	Config   model.ServerSettings `json:"config"`
	Username string               `json:"username"`
	Password string               `json:"password"`
}

// ldapMavisTestConnection binds the directory using the TACACS Settings LDAP
// form values (MAVIS config), for the "Test Bind" button.
func (s *Server) ldapMavisTestConnection(w http.ResponseWriter, r *http.Request) {
	var body mavisTestBody
	if !decodeBody(w, r, &body) {
		return
	}
	msg, err := ldapauth.TestConnection(s.mavisLdapConfig(body.Config))
	if err != nil {
		writeError(w, http.StatusFailedDependency, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": msg})
}

// ldapMavisTestUser authenticates a directory user against the TACACS Settings
// LDAP form values and returns the group-resolution trace, for the "Test User"
// button.
func (s *Server) ldapMavisTestUser(w http.ResponseWriter, r *http.Request) {
	var body mavisTestBody
	if !decodeBody(w, r, &body) {
		return
	}
	res, err := ldapauth.TestUser(s.mavisLdapConfig(body.Config), body.Username, body.Password)
	if err != nil {
		writeError(w, http.StatusFailedDependency, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// ldapHealth reports whether the TACACS+ MAVIS LDAP backend is reachable. It
// binds using the agent's live 03-mavis.cfg config (including the stored bind
// password) so the caller needs no secrets. Response: {enabled, connected,
// message}. Feeds the Dashboard's tri-state LDAP Backend indicator.
func (s *Server) ldapHealth(w http.ResponseWriter, _ *http.Request) {
	set := s.currentSettings()
	if !set.LdapEnabled {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "connected": false, "message": "LDAP backend is disabled."})
		return
	}

	pass := ""
	if src, err := s.Store.ReadEffective(store.MavisFile); err == nil {
		pass = tacconfig.MavisPassword(src)
	}
	host, port, useTLS := parseLdapHost(set.LdapHosts)
	ca, crt, key := s.ldapTLSPaths()
	cfg := ldapauth.Config{
		Host: host, Port: port, UseTLS: useTLS,
		BaseDN: set.LdapBase, BindDN: set.LdapUser, BindPassword: pass,
		ConnectTimeout: set.LdapConnectTimeout,
		TLSMode:        set.LdapTLSMode, TLSVerify: set.LdapTLSVerify,
		CAFile: ca, ClientCertFile: crt, ClientKeyFile: key,
	}
	msg, err := ldapauth.TestConnection(cfg)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "connected": false, "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "connected": true, "message": msg})
}

// parseLdapHost splits the first entry of a MAVIS LDAP_HOSTS value (space or
// comma separated, optionally scheme-prefixed) into host, port and TLS flag.
func parseLdapHost(hosts string) (host, port string, useTLS bool) {
	first := strings.FieldsFunc(strings.TrimSpace(hosts), func(r rune) bool { return r == ' ' || r == ',' })
	h := ""
	if len(first) > 0 {
		h = first[0]
	}
	if strings.HasPrefix(strings.ToLower(h), "ldaps://") {
		useTLS = true
		h = h[len("ldaps://"):]
	} else if strings.HasPrefix(strings.ToLower(h), "ldap://") {
		h = h[len("ldap://"):]
	}
	if i := strings.LastIndex(h, ":"); i >= 0 {
		host, port = h[:i], h[i+1:]
	} else {
		host = h
	}
	return host, port, useTLS
}

// ldapLogin validates a directory user's credentials at sign-in time. It is
// PUBLIC (exempt from bearer auth in authMux) because the caller is not yet
// authenticated; the frontend passes the saved LDAP config with the creds and,
// on success, provisions a Supabase session for the returned email.
func (s *Server) ldapLogin(w http.ResponseWriter, r *http.Request) {
	var body ldapTestBody
	if !decodeBody(w, r, &body) {
		return
	}
	res, err := ldapauth.TestUser(s.cfg(body), body.Username, body.Password)
	if err != nil {
		writeError(w, http.StatusFailedDependency, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
