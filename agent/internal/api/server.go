// Package api exposes the agent's HTTP API on :8081 for soteria-frontend.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Pathfinder-Insights/soteria-agent/internal/dns"
	"github.com/Pathfinder-Insights/soteria-agent/internal/dockerctl"
	"github.com/Pathfinder-Insights/soteria-agent/internal/logsvc"
	"github.com/Pathfinder-Insights/soteria-agent/internal/model"
	"github.com/Pathfinder-Insights/soteria-agent/internal/netbox"
	"github.com/Pathfinder-Insights/soteria-agent/internal/store"
	"github.com/Pathfinder-Insights/soteria-agent/internal/tacconfig"
	"github.com/Pathfinder-Insights/soteria-agent/internal/token"
)

type Server struct {
	Store     *store.Store
	Docker    *dockerctl.Client
	LogDir    string
	GlobalKey string
	// JWTSecret verifies HS256 JWTs (legacy / anon+service keys) when non-empty.
	JWTSecret []byte
	// JWKS verifies ES256 JWTs (modern Supabase user access tokens). Either of
	// these being set turns auth on; /ready is always exempt.
	JWKS *jwksCache
	// Tokens backs the API-token auth path (long-lived, scoped credentials).
	Tokens *token.Store
	// DNS manages authoritative DNS (nil when the bind9 backend isn't mounted).
	DNS dns.Provider
	// NB is the NetBox source-of-truth client (nil when not configured).
	NB *netbox.Client

	// Populated by Handler(): pattern ("METHOD /path") -> required token scope,
	// and the catalog of scopable endpoints (drives the UI + OpenAPI).
	routeScopes  map[string]string
	scopeCatalog []scopeInfo
}

// apiRoute couples an endpoint to the token scope it requires. Web-UI (JWT)
// callers bypass the scope check; API-token callers must hold rt.scope.
type apiRoute struct {
	method, path, scope, desc string
	handler                   http.HandlerFunc
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	routes := []apiRoute{
		{"GET", "/api/status", "status:read", "Agent and TACACS+ status", s.getStatus},

		{"GET", "/api/devices", "devices:read", "List network devices", s.getDevices},
		{"PUT", "/api/devices", "devices:write", "Replace the device collection", s.putDevices},
		{"GET", "/api/device-groups", "device-groups:read", "List device groups", s.getDeviceGroups},
		{"PUT", "/api/device-groups", "device-groups:write", "Replace device groups", s.putDeviceGroups},
		{"GET", "/api/users", "users:read", "List local users", s.getUsers},
		{"PUT", "/api/users", "users:write", "Replace the user collection", s.putUsers},
		{"GET", "/api/groups", "groups:read", "List user groups", s.getGroups},
		{"PUT", "/api/groups", "groups:write", "Replace user groups", s.putGroups},
		{"GET", "/api/profiles", "profiles:read", "List authorization profiles", s.getProfiles},
		{"PUT", "/api/profiles", "profiles:write", "Replace profiles", s.putProfiles},
		{"GET", "/api/rulesets", "rulesets:read", "List rulesets", s.getRulesets},
		{"PUT", "/api/rulesets", "rulesets:write", "Replace rulesets", s.putRulesets},

		{"GET", "/api/logs", "logs:read", "Query AAA logs", s.getLogs},

		{"GET", "/api/dns/zones", "dns:read", "List DNS zones", s.getDNSZones},
		{"GET", "/api/dns/zones/{name}", "dns:read", "Read a DNS zone and its records", s.getDNSZone},
		{"POST", "/api/dns/zones", "dns:write", "Create an authoritative DNS zone", s.createDNSZone},
		{"DELETE", "/api/dns/zones/{name}", "dns:write", "Delete a DNS zone", s.deleteDNSZone},
		{"PUT", "/api/dns/zones/{name}/records", "dns:write", "Replace a DNS zone's records", s.putDNSRecords},
		{"POST", "/api/dns/sot/reverse-zones", "dns:write", "Create reverse zones from NetBox tagged prefixes", s.scanReverseZones},
		{"POST", "/api/dns/zones/{name}/sot-sync", "dns:write", "Sync a zone's records from the NetBox source of truth", s.syncZoneFromSot},

		{"GET", "/api/config/logging", "logging:read", "Read AAA logging config", s.getLogging},
		{"PUT", "/api/config/logging", "logging:write", "Update AAA logging config", s.putLogging},
		{"GET", "/api/config/server-info", "settings:read", "Read server info", s.getServerInfo},
		{"GET", "/api/config/settings", "settings:read", "Read server settings", s.getSettings},
		{"PUT", "/api/config/settings", "settings:write", "Update server settings (LDAP/DNS/listener/TLS)", s.putSettings},
		{"GET", "/api/auth/ldap/health", "settings:read", "Probe the TACACS+ MAVIS LDAP backend", s.ldapHealth},
		{"GET", "/api/config/ldap/certs", "settings:read", "List the LDAP TLS certificate bundle", s.getLdapCerts},
		{"PUT", "/api/config/ldap/certs/{name}", "settings:write", "Upload an LDAP TLS certificate or key", s.putLdapCert},
		{"DELETE", "/api/config/ldap/certs/{name}", "settings:write", "Remove an LDAP TLS certificate or key", s.deleteLdapCert},
		{"POST", "/api/auth/ldap/mavis-test-connection", "settings:read", "Test bind against the MAVIS LDAP settings", s.ldapMavisTestConnection},
		{"POST", "/api/auth/ldap/mavis-test-user", "settings:read", "Test a user login against the MAVIS LDAP settings", s.ldapMavisTestUser},

		{"POST", "/api/tools/auth-test", "tools:auth-test", "Run an authentication test", s.authTest},
		{"POST", "/api/tools/authz-test", "tools:authz-test", "Run a command authorization test", s.authzTest},
		{"POST", "/api/tools/ping", "tools:ping", "Ping from the TACACS+ container", s.pingTest},
		{"POST", "/api/tools/trace", "tools:authz-test", "Trace a TACACS+ AAA decision (tactrace.pl)", s.traceTest},

		{"GET", "/api/staging", "staging:read", "Read staging (Edit Config) state", s.getStaging},
		{"POST", "/api/staging", "staging:write", "Begin an edit session", s.beginStaging},
		{"DELETE", "/api/staging", "staging:write", "Discard staged changes", s.discardStaging},
		{"POST", "/api/staging/commit", "staging:commit", "Validate, apply and reload staged changes", s.commitStaging},
		{"GET", "/api/staging/diff", "staging:read", "Diff staged vs live config", s.getStagingDiff},

		{"GET", "/api/config/files", "config:read", "List config files", s.getConfigFiles},
		{"GET", "/api/config/files/{name...}", "config:read", "Read a config file", s.getConfigFile},
		{"GET", "/api/config/backups", "backups:read", "List config backups", s.getBackups},
		{"POST", "/api/config/backups/{id}/restore", "backups:restore", "Restore a backup (all or specific files)", s.restoreBackup},
		{"GET", "/api/config/backups/{id}/diff", "backups:read", "Diff live config vs a backup", s.getBackupDiff},
		{"PUT", "/api/config/retention", "backups:write", "Set backup retention", s.putRetention},
		{"GET", "/api/config/golden", "config:read", "Read golden config metadata", s.getGolden},
		{"POST", "/api/config/golden/restore", "config:write", "Restore the golden config", s.restoreGolden},
		{"GET", "/api/config/golden/diff", "config:read", "Diff live config vs golden", s.getGoldenDiff},
		{"POST", "/api/config/validate", "config:write", "Validate the live config", s.validateConfig},
		{"POST", "/api/config/reload", "config:write", "Reload TACACS+ (SIGHUP)", s.reloadConfig},
	}

	s.routeScopes = map[string]string{}
	s.scopeCatalog = nil
	for _, rt := range routes {
		pattern := rt.method + " " + rt.path
		mux.HandleFunc(pattern, rt.handler)
		s.routeScopes[pattern] = rt.scope
		s.scopeCatalog = append(s.scopeCatalog, scopeInfo{rt.scope, rt.method, rt.path, rt.desc})
	}

	// Health check: always exempt from auth.
	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// Golden save is admin-only and NOT token-scopable (web session required).
	mux.HandleFunc("PUT /api/config/golden", s.saveGolden)

	// LDAP config tests (admin web session only; secrets in the body).
	mux.HandleFunc("POST /api/auth/ldap/test-connection", s.ldapTestConnection)
	mux.HandleFunc("POST /api/auth/ldap/test-user", s.ldapTestUser)
	mux.HandleFunc("POST /api/auth/ldap/login", s.ldapLogin) // public (pre-auth); exempted in authMux

	// Token management: web session only (an API token cannot mint/list tokens).
	mux.HandleFunc("GET /api/tokens", s.listTokens)
	mux.HandleFunc("POST /api/tokens", s.createToken)
	mux.HandleFunc("DELETE /api/tokens/{id}", s.revokeToken)
	mux.HandleFunc("GET /api/tokens/scopes", s.listScopes)

	return s.cors(s.authMux(mux))
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

// StartTime is set at process start and reported as the agent's uptime base.
var StartTime = time.Now()

type serviceStatus struct {
	Online    bool   `json:"online"`
	Health    string `json:"health,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
	Uptime    string `json:"uptime,omitempty"`
}

func (s *Server) getStatus(w http.ResponseWriter, r *http.Request) {
	agent := serviceStatus{
		Online:    true,
		StartedAt: StartTime.UTC().Format(time.RFC3339),
		Uptime:    formatUptime(time.Since(StartTime)),
	}
	tacacs := serviceStatus{Online: false, Health: "unknown"}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if state, err := s.Docker.TacacsState(ctx); err == nil {
		tacacs.Online = state.Running
		if state.Health != "" {
			tacacs.Health = state.Health
		}
		if state.Running && !state.StartedAt.IsZero() {
			tacacs.StartedAt = state.StartedAt.UTC().Format(time.RFC3339)
			tacacs.Uptime = formatUptime(time.Since(state.StartedAt))
		}
	}
	writeJSON(w, http.StatusOK, map[string]serviceStatus{"agent": agent, "tacacs": tacacs})
}

func formatUptime(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	days := int(d.Hours()) / 24
	hours := int(d.Hours()) % 24
	minutes := int(d.Minutes()) % 60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd %dh %dm", days, hours, minutes)
	case hours > 0:
		return fmt.Sprintf("%dh %dm", hours, minutes)
	default:
		return fmt.Sprintf("%dm", minutes)
	}
}

// ---------------------------------------------------------------------------
// Entity handlers
// ---------------------------------------------------------------------------

func (s *Server) loadDevices() ([]model.Device, error) {
	src, err := s.Store.ReadEffective(store.DevicesFile)
	if err != nil {
		return nil, err
	}
	return tacconfig.ParseDevices(src, s.GlobalKey)
}

func (s *Server) loadDeviceGroups() ([]model.DeviceGroup, error) {
	src, err := s.Store.ReadEffective(store.DevicesFile)
	if err != nil {
		return nil, err
	}
	groups, err := tacconfig.ParseDeviceGroups(src, s.GlobalKey)
	if err != nil {
		return nil, err
	}
	if devices, err := tacconfig.ParseDevices(src, s.GlobalKey); err == nil {
		counts := map[string]int{}
		for _, d := range devices {
			counts[d.Group]++
		}
		for i := range groups {
			groups[i].Members = counts[groups[i].Name]
		}
	}
	return groups, nil
}

func (s *Server) getDevices(w http.ResponseWriter, _ *http.Request) {
	devices, err := s.loadDevices()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, tacconfig.SortDevicesForDisplay(devices))
}

func (s *Server) putDevices(w http.ResponseWriter, r *http.Request) {
	var devices []model.Device
	if !decodeBody(w, r, &devices) {
		return
	}
	existing, err := s.loadDevices()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	groups, err := s.loadDeviceGroups()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	groupNames := map[string]bool{}
	for _, g := range groups {
		groupNames[g.Name] = true
	}
	existingKeys := map[string]string{}
	for _, d := range existing {
		existingKeys[d.Name] = d.Key
	}
	for i := range devices {
		if err := tacconfig.ValidateEntityName("device", devices[i].Name); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if devices[i].Address == "" {
			writeError(w, http.StatusBadRequest, fmt.Errorf("device %s: address is required", devices[i].Name))
			return
		}
		if devices[i].Group != "" && !groupNames[devices[i].Group] {
			writeError(w, http.StatusBadRequest, fmt.Errorf("device %s: device group %q does not exist", devices[i].Name, devices[i].Group))
			return
		}
		if devices[i].KeyType == "group" && devices[i].Group == "" {
			writeError(w, http.StatusBadRequest, fmt.Errorf("device %s: key type 'group' requires a device group", devices[i].Name))
			return
		}
		if devices[i].KeyType == "custom" && devices[i].Key == "" {
			if k := existingKeys[devices[i].Name]; k != "" {
				devices[i].Key = k // key omitted on edit: keep the current one
			} else {
				writeError(w, http.StatusBadRequest, fmt.Errorf("device %s: custom key type requires a key", devices[i].Name))
				return
			}
		}
	}
	s.commitEntities(w, r, store.DevicesFile, tacconfig.RenderDevices(devices, groups, s.GlobalKey))
}

func (s *Server) getDeviceGroups(w http.ResponseWriter, _ *http.Request) {
	groups, err := s.loadDeviceGroups()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

func (s *Server) putDeviceGroups(w http.ResponseWriter, r *http.Request) {
	var groups []model.DeviceGroup
	if !decodeBody(w, r, &groups) {
		return
	}
	devices, err := s.loadDevices()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	current, err := s.loadDeviceGroups()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	existingKeys := map[string]string{}
	for _, g := range current {
		existingKeys[g.Name] = g.Key
	}
	incoming := map[string]bool{}
	for i := range groups {
		if err := tacconfig.ValidateEntityName("device group", groups[i].Name); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		incoming[groups[i].Name] = true
		if groups[i].KeyType == "custom" && groups[i].Key == "" {
			if k := existingKeys[groups[i].Name]; k != "" {
				groups[i].Key = k
			} else {
				writeError(w, http.StatusBadRequest, fmt.Errorf("device group %s: custom key type requires a key", groups[i].Name))
				return
			}
		}
	}
	// A group referenced by devices cannot be deleted.
	memberCount := map[string]int{}
	for _, d := range devices {
		memberCount[d.Group]++
	}
	for _, g := range current {
		if !incoming[g.Name] && memberCount[g.Name] > 0 {
			writeError(w, http.StatusConflict,
				fmt.Errorf("device group %s still has %d member device(s); reassign them before deleting", g.Name, memberCount[g.Name]))
			return
		}
	}
	s.commitEntities(w, r, store.DevicesFile, tacconfig.RenderDevices(devices, groups, s.GlobalKey))
}

func (s *Server) loadUsers() ([]model.User, error) {
	src, err := s.Store.ReadEffective(store.UsersFile)
	if err != nil {
		return nil, err
	}
	return tacconfig.ParseUsers(src)
}

func (s *Server) getUsers(w http.ResponseWriter, _ *http.Request) {
	users, err := s.loadUsers()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) putUsers(w http.ResponseWriter, r *http.Request) {
	var users []model.User
	if !decodeBody(w, r, &users) {
		return
	}
	existing, err := s.loadUsers()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	hashes := map[string]string{}
	for _, u := range existing {
		hashes[u.Name] = u.Hash
	}
	for i := range users {
		if err := tacconfig.ValidateEntityName("user", users[i].Name); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		switch {
		case users[i].Password != "":
			ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
			hash, err := s.Docker.HashPassword(ctx, users[i].Password)
			cancel()
			if err != nil {
				writeError(w, http.StatusBadGateway, err)
				return
			}
			users[i].Hash = hash
			users[i].Password = ""
		case hashes[users[i].Name] != "":
			users[i].Hash = hashes[users[i].Name]
		default:
			writeError(w, http.StatusBadRequest, fmt.Errorf("user %s: password required for new users", users[i].Name))
			return
		}
	}
	s.commitEntities(w, r, store.UsersFile, tacconfig.RenderUsers(users))
}

func (s *Server) loadGroups() ([]model.Group, error) {
	src, err := s.Store.ReadEffective(store.GroupsFile)
	if err != nil {
		return nil, err
	}
	groups, err := tacconfig.ParseGroups(src)
	if err != nil {
		return nil, err
	}
	// Enrich: member counts from local users, profile from ruleset mapping.
	users, err := s.loadUsers()
	if err == nil {
		counts := map[string]int{}
		for _, u := range users {
			counts[u.Group]++
		}
		for i := range groups {
			groups[i].Members = counts[groups[i].Name]
		}
	}
	if src, err := s.Store.ReadEffective(store.RulesetFile); err == nil {
		if rules, err := tacconfig.ParseRuleset(src); err == nil {
			profiles := groupProfileMap(rules)
			for i := range groups {
				groups[i].Profile = profiles[groups[i].Name]
			}
		}
	}
	return groups, nil
}

// groupProfileMap extracts group -> profile assignments from ruleset
// conditions shaped like: if (member == GROUP) { profile = P ... }.
func groupProfileMap(rules []model.Rule) map[string]string {
	out := map[string]string{}
	var walk func(conds []model.RuleCondition)
	walk = func(conds []model.RuleCondition) {
		for _, c := range conds {
			if c.Attribute == "member" && c.Operator == "==" {
				for _, a := range c.Actions {
					var p string
					if n, _ := fmt.Sscanf(a, "profile = %s", &p); n == 1 {
						if _, seen := out[c.Value]; !seen {
							out[c.Value] = p
						}
					}
				}
			}
			walk(c.Children)
		}
	}
	for _, r := range rules {
		walk(r.Matches)
	}
	return out
}

func (s *Server) getGroups(w http.ResponseWriter, _ *http.Request) {
	groups, err := s.loadGroups()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

func (s *Server) putGroups(w http.ResponseWriter, r *http.Request) {
	var groups []model.Group
	if !decodeBody(w, r, &groups) {
		return
	}
	current, err := s.loadGroups()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	// Mirror soteria's `group remove` validation: a group with members
	// cannot be deleted.
	incoming := map[string]bool{}
	for i := range groups {
		if err := tacconfig.ValidateEntityName("group", groups[i].Name); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		incoming[groups[i].Name] = true
	}
	for _, g := range current {
		if !incoming[g.Name] && g.Members > 0 {
			writeError(w, http.StatusConflict,
				fmt.Errorf("group %s still has %d member(s); reassign them before deleting", g.Name, g.Members))
			return
		}
	}
	s.commitEntities(w, r, store.GroupsFile, tacconfig.RenderGroups(groups))
}

func (s *Server) getProfiles(w http.ResponseWriter, _ *http.Request) {
	src, err := s.Store.ReadEffective(store.ProfilesFile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	profiles, err := tacconfig.ParseProfiles(src)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, profiles)
}

func (s *Server) putProfiles(w http.ResponseWriter, r *http.Request) {
	var profiles []model.Profile
	if !decodeBody(w, r, &profiles) {
		return
	}
	for _, p := range profiles {
		if err := tacconfig.ValidateEntityName("profile", p.Name); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}
	s.commitEntities(w, r, store.ProfilesFile, tacconfig.RenderProfiles(profiles))
}

func (s *Server) getRulesets(w http.ResponseWriter, _ *http.Request) {
	src, err := s.Store.ReadEffective(store.RulesetFile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	rules, err := tacconfig.ParseRuleset(src)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, rules)
}

func (s *Server) putRulesets(w http.ResponseWriter, r *http.Request) {
	var rules []model.Rule
	if !decodeBody(w, r, &rules) {
		return
	}
	s.commitEntities(w, r, store.RulesetFile, tacconfig.RenderRuleset(rules))
}

// commitEntities stages rendered entity config. Nothing reaches the live
// config until POST /api/staging/commit; writes outside an edit session
// are rejected so the Edit Config workflow is enforced server-side.
func (s *Server) commitEntities(w http.ResponseWriter, _ *http.Request, file, content string) {
	if err := s.Store.WriteStaged(file, content); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrStagingInactive) {
			status = http.StatusConflict
		}
		writeError(w, status, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "staged", "file": file})
}

// ---------------------------------------------------------------------------
// Staging (Edit Config mode)
// ---------------------------------------------------------------------------

func (s *Server) getStaging(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"active":          s.Store.StagingActive(),
		"changedFiles":    s.Store.ChangedFiles(),
		"retention":       s.Store.Retention(),
		"restartRequired": s.Store.RestartPending(),
	})
}

func (s *Server) beginStaging(w http.ResponseWriter, _ *http.Request) {
	if err := s.Store.BeginStaging(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "editing"})
}

func (s *Server) discardStaging(w http.ResponseWriter, _ *http.Request) {
	if err := s.Store.DiscardStaging(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "discarded"})
}

func (s *Server) commitStaging(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	out, err := s.Store.CommitStaging(ctx)
	if err != nil {
		status := http.StatusUnprocessableEntity
		if errors.Is(err, store.ErrStagingInactive) {
			status = http.StatusConflict
		}
		writeJSON(w, status, map[string]string{"error": err.Error(), "validatorOutput": out})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "committed", "validatorOutput": out})
}

func (s *Server) getStagingDiff(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Store.StagedDiffs())
}

// ---------------------------------------------------------------------------
// Golden config (protected baseline)
// ---------------------------------------------------------------------------

// requireAdmin enforces the frontend's Super User role (JWT claim
// app_metadata.role == "admin"). With auth disabled (no AGENT_JWT_SECRET)
// there is nothing to check against, so the action is allowed — lab mode.
// authEnabled reports whether any JWT verification method is configured. When
// false the agent runs open (lab mode) and treats callers as local admin.
func (s *Server) authEnabled() bool {
	return len(s.JWTSecret) > 0 || s.JWKS != nil
}

func (s *Server) requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if !s.authEnabled() {
		return true
	}
	id := identityFrom(r.Context())
	if id == nil || !id.IsUser {
		writeError(w, http.StatusForbidden, fmt.Errorf("a web session is required for this action"))
		return false
	}
	if id.Role != "admin" {
		writeError(w, http.StatusForbidden, fmt.Errorf("only administrators can perform this action"))
		return false
	}
	return true
}

func (s *Server) getGolden(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Store.Golden())
}

func (s *Server) saveGolden(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	if err := s.Store.SaveGolden(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "golden": s.Store.Golden()})
}

func (s *Server) restoreGolden(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	out, err := s.Store.RestoreGolden(ctx)
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error(), "validatorOutput": out})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "restored", "validatorOutput": out})
}

func (s *Server) getGoldenDiff(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Store.GoldenDiffs())
}

// getBackupDiff returns what restoring the backup would change
// (live -> backup). Optional ?file= narrows to one config file.
func (s *Server) getBackupDiff(w http.ResponseWriter, r *http.Request) {
	var files []string
	if f := r.URL.Query().Get("file"); f != "" {
		files = []string{f}
	}
	diffs, err := s.Store.BackupDiff(r.PathValue("id"), files)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, diffs)
}

func (s *Server) putRetention(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Retention int `json:"retention"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if err := s.Store.SetRetention(body.Retention); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "saved", "retention": s.Store.Retention()})
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

func (s *Server) getLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	// Accept a range (from/to); fall back to single ?date= for compat.
	from, to := q.Get("from"), q.Get("to")
	if from == "" && to == "" {
		from, to = q.Get("date"), q.Get("date")
	}
	devices, _ := s.loadDevices()
	entries, err := logsvc.Query(s.LogDir, from, to, q.Get("type"), devices)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

// ---------------------------------------------------------------------------
// Server info — env-managed settings (read-only reference for the UI)
// ---------------------------------------------------------------------------

// getServerInfo reports the current TLS/LDAP/DNS/listener settings sourced
// from the server's environment (shared .env). These are set at container
// start and require a restart to change, so they are read-only here.
// Secrets (keys, bind password) are redacted to a boolean "set" flag.
func (s *Server) getServerInfo(w http.ResponseWriter, _ *http.Request) {
	env := func(k string) string { return os.Getenv(k) }
	boolEnv := func(k string) bool { return strings.EqualFold(os.Getenv(k), "true") }
	set := func(k string) bool { return os.Getenv(k) != "" }
	def := func(k, d string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return d
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"note": "These come from the server .env and take effect on container restart — not editable from the web UI.",
		"server": map[string]any{
			"listenPort": def("TACACS_LISTEN_PORT", "49"),
			"keySet":     s.GlobalKey != "",
			"timezone":   def("TZ", "UTC"),
		},
		"tls": map[string]any{
			"enabled": boolEnv("ENABLE_TLS"),
			"port":    def("TACACS_TLS_PORT", "300"),
		},
		"ldap": map[string]any{
			"enabled":       boolEnv("ENABLE_LDAP"),
			"serverType":    def("LDAP_SERVER_TYPE", "microsoft"),
			"hosts":         env("LDAP_HOSTS"),
			"bindDn":        env("LDAP_USER"),
			"bindPassSet":   set("LDAP_PASSWD"),
			"baseDn":        env("LDAP_BASE"),
			"groupBaseDn":   env("LDAP_BASE_GROUP"),
			"userFilter":    env("LDAP_FILTER"),
			"groupFilter":   env("LDAP_FILTER_GROUP"),
			"connectTimeout": def("LDAP_CONNECT_TIMEOUT", "5"),
		},
		"dns": map[string]any{
			"primary": env("DNS_SERVER_IP_01"),
		},
		"logRotation": map[string]any{
			"logrotate":      !strings.EqualFold(env("ENABLE_LOGROTATE"), "false"),
			"monthlyArchive": !strings.EqualFold(env("ENABLE_MONTHLY_ARCHIVE"), "false"),
		},
	})
}

// ---------------------------------------------------------------------------
// Server settings. LDAP + DNS apply live via SIGHUP; the restart-group
// (listen port, TLS, timezone, log rotation) applies via a container restart.
// ---------------------------------------------------------------------------

func (s *Server) currentSettings() model.ServerSettings {
	set := model.ServerSettings{}
	if src, err := s.Store.ReadEffective(store.DNSFile); err == nil {
		tacconfig.ParseDNS(src, &set)
	}
	if src, err := s.Store.ReadEffective(store.MavisFile); err == nil {
		tacconfig.ParseMavis(src, &set)
	}
	if src, err := s.Store.ReadEffective(store.MainFile); err == nil {
		set.LdapEnabled = tacconfig.MavisIncludeEnabled(src)
		set.ListenPort = tacconfig.ParseListenPort(src)
		set.TLSEnabled = tacconfig.TLSEnabled(src)
	}
	set.SharedKeySet = s.GlobalKey != ""
	set.TLSPort = "300"

	// TZ + log rotation come from the overrides file if present, else env.
	set.Timezone = firstNonEmpty(os.Getenv("TZ"), "UTC")
	set.Logrotate = !strings.EqualFold(os.Getenv("ENABLE_LOGROTATE"), "false")
	set.MonthlyArchive = !strings.EqualFold(os.Getenv("ENABLE_MONTHLY_ARCHIVE"), "false")
	if src, err := s.Store.ReadEffective(store.OverridesFile); err == nil && src != "" {
		tacconfig.ParseOverrides(src, &set)
	}
	return set
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func (s *Server) getSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.currentSettings())
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var in model.ServerSettings
	if !decodeBody(w, r, &in) {
		return
	}
	// Capture whether a new bind password was supplied before we backfill it
	// from the stored one below (used to decide if a restart is needed).
	ldapPasswordSupplied := strings.TrimSpace(in.LdapPassword) != ""
	if in.LdapEnabled {
		if in.LdapHosts == "" || in.LdapUser == "" || in.LdapBase == "" {
			writeError(w, http.StatusBadRequest, fmt.Errorf("LDAP hosts, bind DN and search base are required when LDAP is enabled"))
			return
		}
	}
	cur := s.currentSettings()

	// Enabling TLS needs the three cert files present in the container.
	if in.TLSEnabled && !cur.TLSEnabled {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		missing := ""
		for _, f := range []string{"server.crt", "server.key", "ca.crt"} {
			if !s.Docker.FileExists(ctx, "/etc/tac_plus-ng/tls/"+f) {
				missing = f
				break
			}
		}
		cancel()
		if missing != "" {
			writeError(w, http.StatusBadRequest, fmt.Errorf("cannot enable TLS: /etc/tac_plus-ng/tls/%s not found - mount the tls/ directory with server.crt, server.key, ca.crt first", missing))
			return
		}
	}

	// Preserve the existing bind password when the field is left blank.
	if in.LdapPassword == "" {
		if src, err := s.Store.ReadEffective(store.MavisFile); err == nil {
			in.LdapPassword = tacconfig.MavisPassword(src)
		}
	}

	stage := func(file, content string) bool {
		if err := s.Store.WriteStaged(file, content); err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, store.ErrStagingInactive) {
				status = http.StatusConflict
			}
			writeError(w, status, err)
			return false
		}
		return true
	}

	main, err := s.Store.ReadEffective(store.MainFile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	// Apply all main-config edits together (mavis include, listen port, TLS).
	main = tacconfig.SetMavisInclude(main, in.LdapEnabled)
	main = tacconfig.SetListenPort(main, in.ListenPort)
	main = tacconfig.SetTLS(main, in.TLSEnabled)

	if !stage(store.DNSFile, tacconfig.RenderDNS(in)) ||
		!stage(store.MavisFile, tacconfig.RenderMavis(in)) ||
		!stage(store.MainFile, main) ||
		!stage(store.OverridesFile, tacconfig.RenderOverrides(in)) {
		return
	}

	// Restart-group changes need a container restart. LDAP is one of them:
	// tac_plus-ng only spawns the MAVIS external backend at daemon startup and
	// the entrypoint activates it only when ENABLE_LDAP=true, so enabling,
	// disabling, or reconfiguring LDAP all require a restart (a SIGHUP reload
	// never starts MAVIS). DNS still applies via SIGHUP.
	ldapChanged := in.LdapEnabled != cur.LdapEnabled
	if in.LdapEnabled && !ldapChanged {
		ldapChanged = ldapPasswordSupplied ||
			in.LdapServerType != cur.LdapServerType || in.LdapHosts != cur.LdapHosts ||
			in.LdapUser != cur.LdapUser || in.LdapBase != cur.LdapBase ||
			in.LdapBaseGroup != cur.LdapBaseGroup || in.LdapFilter != cur.LdapFilter ||
			in.LdapFilterGroup != cur.LdapFilterGroup || in.LdapTacMember != cur.LdapTacMember ||
			in.LdapConnectTimeout != cur.LdapConnectTimeout ||
			in.LdapTLSMode != cur.LdapTLSMode || in.LdapTLSVerify != cur.LdapTLSVerify
	}
	needsRestart := ldapChanged || in.ListenPort != cur.ListenPort || in.TLSEnabled != cur.TLSEnabled ||
		in.Timezone != cur.Timezone || in.Logrotate != cur.Logrotate || in.MonthlyArchive != cur.MonthlyArchive
	if needsRestart {
		if err := s.Store.MarkRestart(); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "staged", "restartRequired": needsRestart})
}

// ---------------------------------------------------------------------------
// AAA logging config (01-logging.cfg — staged like entity files)
// ---------------------------------------------------------------------------

func (s *Server) getLogging(w http.ResponseWriter, _ *http.Request) {
	src, err := s.Store.ReadEffective(store.LoggingFile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	cfg, err := tacconfig.ParseLogging(src)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) putLogging(w http.ResponseWriter, r *http.Request) {
	var cfg model.LoggingConfig
	if !decodeBody(w, r, &cfg) {
		return
	}
	if err := tacconfig.ValidateLogging(cfg); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	s.commitEntities(w, r, store.LoggingFile, tacconfig.RenderLogging(cfg))
}

// ---------------------------------------------------------------------------
// Config files, backups, validate, reload
// ---------------------------------------------------------------------------

func (s *Server) getConfigFiles(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Store.ListFiles())
}

func (s *Server) getConfigFile(w http.ResponseWriter, r *http.Request) {
	content, err := s.Store.ReadEffective(r.PathValue("name"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(content))
}

func (s *Server) getBackups(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Store.Backups())
}

func (s *Server) restoreBackup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Files []string `json:"files"`
	}
	if r.ContentLength > 0 && !decodeBody(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	out, err := s.Store.Restore(ctx, r.PathValue("id"), body.Files)
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"error":           err.Error(),
			"validatorOutput": out,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "restored", "validatorOutput": out})
}

func (s *Server) validateConfig(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	out, err := s.Docker.ValidateConfig(ctx)
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error(), "output": out})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "valid", "output": out})
}

func (s *Server) reloadConfig(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.Docker.ReloadTacacs(ctx); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "reloaded"})
}

// ---------------------------------------------------------------------------
// Middleware & helpers
// ---------------------------------------------------------------------------

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// authMux authenticates every request (except /ready) as either a web-UI user
// (Supabase JWT, unrestricted API access) or an API token (limited to its
// scopes, checked against the matched route). The caller identity is stashed in
// the request context for handlers (admin checks, token ownership).
func (s *Server) authMux(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ready" || r.URL.Path == "/api/auth/ldap/login" {
			mux.ServeHTTP(w, r) // health check + pre-auth LDAP login are public
			return
		}
		// Lab mode: no auth configured -> allow all, act as local admin.
		if !s.authEnabled() {
			ctx := withIdentity(r.Context(), &identity{IsUser: true, Email: "local", Role: "admin"})
			mux.ServeHTTP(w, r.WithContext(ctx))
			return
		}
		tok, ok := bearerToken(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, fmt.Errorf("missing bearer token"))
			return
		}

		var id *identity
		if strings.HasPrefix(tok, token.Prefix) {
			// API token.
			var valid bool
			id, valid = s.verifyToken(tok)
			if !valid {
				writeError(w, http.StatusUnauthorized, fmt.Errorf("invalid or expired API token"))
				return
			}
		} else {
			// Web-UI Supabase JWT: scopes + role travel in app_metadata.
			claims, valid := s.verifyJWT(tok)
			if !valid {
				writeError(w, http.StatusUnauthorized, fmt.Errorf("invalid bearer token"))
				return
			}
			id = &identity{IsUser: true, Email: claims.Email, Role: claims.AppMetadata.Role, Scopes: claims.AppMetadata.Scopes}
		}

		_, pattern := mux.Handler(r)
		if status, err := s.authorize(id, pattern); err != nil {
			writeError(w, status, err)
			return
		}
		mux.ServeHTTP(w, r.WithContext(withIdentity(r.Context(), id)))
	})
}

// authorize applies scope rules to the matched route. Admins (web role "admin")
// are unrestricted. API tokens and non-admin web users are limited to their
// scopes; web users additionally get a status:read baseline and access to
// web-session-only routes (token management). A non-admin web user with no
// scopes (no access group) is denied everything else.
func (s *Server) authorize(id *identity, pattern string) (int, error) {
	if id.Role == "admin" {
		return 0, nil
	}
	needed := s.routeScopes[pattern]
	if !id.IsUser { // API token
		if needed == "" {
			return http.StatusForbidden, fmt.Errorf("this endpoint is not accessible with an API token")
		}
		if !hasScope(id.Scopes, needed) {
			return http.StatusForbidden, fmt.Errorf("API token is missing the required scope %q", needed)
		}
		return 0, nil
	}
	// Non-admin web user.
	if needed == "" || needed == "status:read" {
		return 0, nil
	}
	if !hasScope(id.Scopes, needed) {
		return http.StatusForbidden, fmt.Errorf("your access group does not grant the %q scope", needed)
	}
	return 0, nil
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid request body: %w", err))
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("api: encoding response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
