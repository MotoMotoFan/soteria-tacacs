package api

import (
	"context"
	"fmt"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

// Diagnostic tools. Everything runs INSIDE the soteria-tacacs container
// (docker exec with argv arrays — no shell interpolation), so tests see
// exactly what the server sees: auth/authz hit the real daemon on
// localhost:49 and show up in the AAA logs like any device request.

const authTestScript = `
use Net::TacacsPlus::Client;
my ($key, $user, $pass) = @ARGV;
my $c = Net::TacacsPlus::Client->new(host => "localhost", key => $key, timeout => 5);
my $ok = eval { $c->authenticate($user, $pass, 2) }; # 2 = PAP
if ($@) { my $e = $@; $e =~ s/\s+$//; print "ERROR\n$e"; }
elsif ($ok) { print "OK\nauthentication succeeded (PAP)"; }
else { print "FAIL\nauthentication rejected by server"; }
eval { $c->close() };
`

const authzTestScript = `
use Net::TacacsPlus::Client;
my ($key, $user, @av) = @ARGV;
my $c = Net::TacacsPlus::Client->new(host => "localhost", key => $key, timeout => 5);
my @resp;
my $ok = eval { $c->authorize($user, \@av, \@resp) };
if ($@) { my $e = $@; $e =~ s/\s+$//; print "ERROR\n$e"; }
elsif ($ok) { print "PERMIT\n", join("\n", @resp); }
else { print "DENY\nauthorization rejected by server"; }
eval { $c->close() };
`

type toolResult struct {
	Success   bool     `json:"success"`
	Verdict   string   `json:"verdict"` // OK | FAIL | PERMIT | DENY | ERROR
	Message   string   `json:"message"`
	Attributes []string `json:"attributes,omitempty"` // AV pairs returned on authorization
	LatencyMs int64    `json:"latencyMs"`
}

func validToolName(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	return !strings.ContainsAny(s, " \t\r\n\x00")
}

// runToolScript executes a perl one-liner in the server container and maps
// the VERDICT\nmessage... convention into a toolResult.
func (s *Server) runToolScript(ctx context.Context, script string, args []string) (*toolResult, error) {
	cmd := append([]string{"perl", "-e", script, "--", s.GlobalKey}, args...)
	start := time.Now()
	// stdout carries our VERDICT line; the TACACS+ perl client prints
	// warnings to stderr that would otherwise corrupt the first line.
	exitCode, stdout, stderr, err := s.Docker.ExecStreams(ctx, cmd)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return nil, err
	}
	verdict, rest, _ := strings.Cut(strings.TrimSpace(stdout), "\n")
	if verdict == "" {
		verdict = "ERROR"
		rest = strings.TrimSpace(stderr)
		if rest == "" {
			rest = fmt.Sprintf("test runner exited with code %d (no output)", exitCode)
		}
	}
	res := &toolResult{
		Verdict:   verdict,
		Success:   verdict == "OK" || verdict == "PERMIT",
		LatencyMs: latency,
	}
	if verdict == "PERMIT" {
		for _, line := range strings.Split(rest, "\n") {
			if line = strings.TrimSpace(line); line != "" {
				res.Attributes = append(res.Attributes, line)
			}
		}
		res.Message = "authorization permitted"
	} else {
		res.Message = strings.TrimSpace(rest)
	}
	return res, nil
}

// POST /api/tools/auth-test — real PAP authentication against the server.
func (s *Server) authTest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if !validToolName(body.Username) || body.Password == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("username and password are required"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	res, err := s.runToolScript(ctx, authTestScript, []string{body.Username, body.Password})
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// POST /api/tools/authz-test — real shell command authorization.
func (s *Server) authzTest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Service  string `json:"service"`
		Command  string `json:"command"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if !validToolName(body.Username) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("username is required"))
		return
	}
	if body.Service == "" {
		body.Service = "shell"
	}
	if !validToolName(body.Service) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid service name"))
		return
	}
	// "show running-config" → cmd=show, cmd-arg=running-config (one per word,
	// the way NAS devices send it), terminated with <cr>.
	av := []string{"service=" + body.Service}
	words := strings.Fields(body.Command)
	if len(words) > 0 {
		av = append(av, "cmd="+words[0])
		for _, arg := range words[1:] {
			av = append(av, "cmd-arg="+arg)
		}
		av = append(av, "cmd-arg=<cr>")
	} else {
		av = append(av, "cmd=") // shell start (session authorization)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	res, err := s.runToolScript(ctx, authzTestScript, append([]string{body.Username}, av...))
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// tactraceConfigPath is a throwaway tac_plus-ng config for tactrace.pl holding
// only the AAA-decision files. logging/DNS/MAVIS are deliberately excluded:
// each one crashes the short-lived daemon tactrace spawns, and none of them is
// part of the authorization decision — this also keeps the trace from writing
// to the real AAA log files.
const tactraceConfigPath = "/tmp/soteria-tactrace.cfg"

// buildTraceConfig returns the tac_plus-ng config tactrace runs against. When
// group is set, the traced user is injected as a temporary local member of that
// group so tactrace can resolve it WITHOUT the MAVIS/LDAP backend (which crashes
// its throwaway daemon) and still evaluate the real ruleset/profiles. Callers
// must validate username/group first (validToolName); they are written via an
// env var, never a shell string, so there is no injection surface here.
func buildTraceConfig(username, group string) string {
	var b strings.Builder
	b.WriteString("id = spawnd { background = no }\n")
	b.WriteString("id = tac_plus-ng {\n")
	for _, f := range []string{"04-devices.cfg", "06-groups.cfg", "07-profiles.cfg", "08-ruleset.cfg", "05-local-users.cfg"} {
		b.WriteString("    include = /etc/tac_plus-ng/conf.d/" + f + "\n")
	}
	if group != "" {
		fmt.Fprintf(&b, "    user %s {\n        member = %s\n    }\n", username, group)
	}
	b.WriteString("}\n")
	return b.String()
}

type traceResult struct {
	Verdict   string `json:"verdict"` // PERMIT | DENY | ERROR | UNKNOWN
	Output    string `json:"output"`
	LatencyMs int64  `json:"latencyMs"`
}

// traceVerdict derives a coarse verdict from tactrace's output.
func traceVerdict(out string) string {
	switch {
	case strings.Contains(out, "prematurely closed"):
		return "ERROR"
	case strings.Contains(out, "/PASS"):
		return "PERMIT"
	case strings.Contains(out, "/FAIL"), strings.Contains(out, "denied"):
		return "DENY"
	default:
		return "UNKNOWN"
	}
}

// POST /api/tools/trace — trace an AAA decision through the live rules using
// tac_plus-ng's tactrace.pl. Shows the full packet + rule evaluation, unlike
// the pass/fail auth/authz tests.
func (s *Server) traceTest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode     string `json:"mode"` // authc | authz | acct
		Username string `json:"username"`
		Password string `json:"password"`
		Service  string `json:"service"`
		Command  string `json:"command"`
		Group    string `json:"group"` // optional: trace as a temp member of this group
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if !validToolName(body.Username) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("username is required"))
		return
	}
	if body.Group != "" && !validToolName(body.Group) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid group name"))
		return
	}
	mode := body.Mode
	if mode == "" {
		mode = "authz"
	}
	if mode != "authc" && mode != "authz" && mode != "acct" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("mode must be authc, authz or acct"))
		return
	}
	if mode == "authc" && body.Password == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("password is required for an authentication trace"))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Stage the trace config. Content (incl. the validated username/group) is
	// passed via an env var and written verbatim with printf, so it is never
	// interpreted by the shell.
	writeCmd := []string{"sh", "-c", "printf '%s' \"$SOTERIA_TRACE_CFG\" > " + tactraceConfigPath}
	writeEnv := []string{"SOTERIA_TRACE_CFG=" + buildTraceConfig(body.Username, body.Group)}
	if code, _, stderr, err := s.Docker.ExecStreamsEnv(ctx, writeCmd, writeEnv); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	} else if code != 0 {
		writeError(w, http.StatusBadGateway, fmt.Errorf("could not stage trace config: %s", strings.TrimSpace(stderr)))
		return
	}

	// Build argv; user-controlled values are distinct args, never a shell string.
	// No --debug: the rule-evaluation trace already shows once the user resolves;
	// --debug would only add noisy hex packet dumps.
	args := []string{
		"/usr/local/bin/tactrace.pl",
		"--conf=" + tactraceConfigPath,
		"--key=" + s.GlobalKey,
		"--nad=127.0.0.1",
		"--username=" + body.Username,
		"--mode=" + mode,
	}
	if mode == "authz" || mode == "acct" {
		service := body.Service
		if service == "" {
			service = "shell"
		}
		if !validToolName(service) {
			writeError(w, http.StatusBadRequest, fmt.Errorf("invalid service name"))
			return
		}
		args = append(args, "service="+service)
		words := strings.Fields(body.Command)
		if len(words) > 0 {
			args = append(args, "cmd="+words[0])
			for _, arg := range words[1:] {
				args = append(args, "cmd-arg="+arg)
			}
			args = append(args, "cmd-arg=<cr>")
		} else {
			args = append(args, "cmd=")
		}
	}

	// The password goes via the environment (tactrace reads TACTRACEPASSWORD),
	// never argv, so it never appears in the container's process listing.
	var env []string
	if mode == "authc" {
		env = []string{"TACTRACEPASSWORD=" + body.Password}
	}

	start := time.Now()
	_, stdout, stderr, err := s.Docker.ExecStreamsEnv(ctx, args, env)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	out := stdout
	if strings.TrimSpace(out) == "" {
		out = stderr
	}
	writeJSON(w, http.StatusOK, traceResult{
		Verdict:   traceVerdict(out),
		Output:    strings.TrimRight(out, "\n"),
		LatencyMs: latency,
	})
}

// POST /api/tools/ping — fping from the TACACS server container.
func (s *Server) pingTest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Target string `json:"target"`
		Count  int    `json:"count"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	target := strings.TrimSpace(body.Target)
	if target == "" || len(target) > 253 || strings.ContainsAny(target, " \t\r\n\"'`$;|&<>(){}") {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid ping target"))
		return
	}
	if _, err := netip.ParseAddr(target); err != nil && !isHostnameLike(target) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("target must be an IP address or hostname"))
		return
	}
	count := body.Count
	if count < 1 || count > 10 {
		count = 4
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	start := time.Now()
	// fping writes its per-host summary to stderr; merge both for display.
	exitCode, output, err := s.Docker.Exec(ctx, []string{"fping", "-c", fmt.Sprint(count), target})
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success":   exitCode == 0,
		"output":    strings.TrimSpace(output),
		"latencyMs": time.Since(start).Milliseconds(),
	})
}

func isHostnameLike(s string) bool {
	for _, label := range strings.Split(s, ".") {
		if label == "" {
			return false
		}
		for _, r := range label {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
				return false
			}
		}
	}
	return true
}
