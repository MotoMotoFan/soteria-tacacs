// Package dockerctl talks to the Docker Engine API over the unix socket
// mounted into the agent container. It is deliberately dependency-free:
// the three operations the agent needs (kill -HUP, exec, exec-inspect)
// are simple REST calls.
package dockerctl

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const validateCmd = "/usr/local/sbin/tac_plus-ng"
const validateCfg = "/etc/tac_plus-ng/tac_plus-ng.cfg"

type Client struct {
	http      *http.Client
	container string
}

// New returns a client bound to the TACACS+ server container (by name).
func New(socketPath, container string) *Client {
	return &Client{
		container: container,
		http: &http.Client{
			Timeout: 60 * time.Second,
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					var d net.Dialer
					return d.DialContext(ctx, "unix", socketPath)
				},
			},
		},
	}
}

func (c *Client) url(path string) string { return "http://docker" + path }

// Ping verifies the Docker socket is reachable.
func (c *Client) Ping(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.url("/_ping"), nil)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("docker socket unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("docker ping returned %s", resp.Status)
	}
	return nil
}

// ContainerState describes the TACACS+ server container's runtime state.
type ContainerState struct {
	Running   bool
	Health    string // healthy | unhealthy | starting | "" (no healthcheck)
	StartedAt time.Time
}

// TacacsState inspects the server container.
func (c *Client) TacacsState(ctx context.Context) (*ContainerState, error) {
	var out struct {
		State struct {
			Running   bool   `json:"Running"`
			StartedAt string `json:"StartedAt"`
			Health    *struct {
				Status string `json:"Status"`
			} `json:"Health"`
		} `json:"State"`
	}
	if err := c.getJSON(ctx, "/containers/"+c.container+"/json", &out); err != nil {
		return nil, err
	}
	state := &ContainerState{Running: out.State.Running}
	if out.State.Health != nil {
		state.Health = out.State.Health.Status
	}
	if t, err := time.Parse(time.RFC3339Nano, out.State.StartedAt); err == nil {
		state.StartedAt = t
	}
	return state, nil
}

// RestartTacacs restarts the server container (re-runs the entrypoint, so
// it picks up config-file changes that need more than a SIGHUP reload —
// e.g. new listeners, timezone, cron/log-rotation). Config lives in the
// shared volume, so no recreate is needed.
func (c *Client) RestartTacacs(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		c.url("/containers/"+c.container+"/restart?t=10"), nil)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("restarting %s: %w", c.container, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("restart %s: %s: %s", c.container, resp.Status, strings.TrimSpace(string(body)))
	}
	return nil
}

// FileExists reports whether a path exists inside the server container.
func (c *Client) FileExists(ctx context.Context, path string) bool {
	code, _, _, err := c.ExecStreams(ctx, []string{"test", "-f", path})
	return err == nil && code == 0
}

// ReloadTacacs sends SIGHUP to the server container. Its entrypoint traps
// the signal and forwards it to tac_plus-ng, which re-reads its config
// without dropping the listener.
func (c *Client) ReloadTacacs(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		c.url("/containers/"+c.container+"/kill?signal=HUP"), nil)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("sending SIGHUP to %s: %w", c.container, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return nil
	}
	body, _ := io.ReadAll(resp.Body)
	switch resp.StatusCode {
	case http.StatusConflict:
		return fmt.Errorf("TACACS+ server (%s) is not running - start the container and retry", c.container)
	case http.StatusNotFound:
		return fmt.Errorf("TACACS+ server container %q not found - check the deployment", c.container)
	default:
		return fmt.Errorf("SIGHUP %s: %s: %s", c.container, resp.Status, strings.TrimSpace(string(body)))
	}
}

// ReloadContainer sends SIGHUP to an arbitrary container by name. Used to
// reload BIND9 (named reloads its config + changed zones on SIGHUP) without a
// full restart.
func (c *Client) ReloadContainer(ctx context.Context, name string) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		c.url("/containers/"+name+"/kill?signal=HUP"), nil)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("sending SIGHUP to %s: %w", name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return nil
	}
	body, _ := io.ReadAll(resp.Body)
	// Turn Docker's raw errors into an actionable message. A 409 means the
	// container exists but isn't running; a 404 means it's missing entirely.
	switch resp.StatusCode {
	case http.StatusConflict:
		return fmt.Errorf("DNS server (%s) is not running - start the container and retry", name)
	case http.StatusNotFound:
		return fmt.Errorf("DNS server container %q not found - check the deployment", name)
	default:
		return fmt.Errorf("SIGHUP %s: %s: %s", name, resp.Status, strings.TrimSpace(string(body)))
	}
}

// ValidateConfig runs `tac_plus-ng -P` inside the server container against
// the shared config volume. The agent image does not ship the binary, so
// validation always uses the exact binary that will load the config.
func (c *Client) ValidateConfig(ctx context.Context) (string, error) {
	exitCode, output, err := c.Exec(ctx, []string{validateCmd, "-P", validateCfg})
	if err != nil {
		return output, fmt.Errorf("config validation exec failed: %w", err)
	}
	if exitCode != 0 {
		return output, fmt.Errorf("config validation failed (exit %d)", exitCode)
	}
	return output, nil
}

// HashPassword generates a SHA-512 crypt hash inside the server container
// (glibc crypt via perl - the agent image has no crypt implementation, and
// this guarantees the hash format matches what tac_plus-ng expects).
func (c *Client) HashPassword(ctx context.Context, password string) (string, error) {
	salt, err := cryptSalt()
	if err != nil {
		return "", err
	}
	exitCode, output, err := c.Exec(ctx, []string{
		"perl", "-e", `print crypt($ARGV[0], $ARGV[1])`, "--", password, "$6$" + salt + "$",
	})
	if err != nil {
		return "", fmt.Errorf("password hashing exec failed: %w", err)
	}
	hash := strings.TrimSpace(output)
	if exitCode != 0 || !strings.HasPrefix(hash, "$6$") {
		return "", fmt.Errorf("password hashing failed (exit %d): %s", exitCode, hash)
	}
	return hash, nil
}

func cryptSalt() (string, error) {
	const alphabet = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generating salt: %w", err)
	}
	for i, b := range raw {
		raw[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(raw), nil
}

// Exec runs a command in the server container and returns the exit code
// plus combined stdout+stderr. Use ExecStreams when you must distinguish
// them (e.g. parsing a program's stdout while ignoring library warnings on
// stderr).
func (c *Client) Exec(ctx context.Context, cmd []string) (int, string, error) {
	code, stdout, stderr, err := c.ExecStreams(ctx, cmd)
	combined := stdout
	if stderr != "" {
		if combined != "" {
			combined += "\n"
		}
		combined += stderr
	}
	return code, combined, err
}

// ExecStreams runs a command and returns exit code, stdout, and stderr
// separately.
func (c *Client) ExecStreams(ctx context.Context, cmd []string) (int, string, string, error) {
	return c.ExecStreamsEnv(ctx, cmd, nil)
}

// ExecStreamsEnv is ExecStreams with extra environment variables (each
// "KEY=value"), used to pass secrets (e.g. TACTRACEPASSWORD) out of the argv
// so they don't appear in the container's process listing.
func (c *Client) ExecStreamsEnv(ctx context.Context, cmd []string, env []string) (int, string, string, error) {
	create := map[string]any{
		"AttachStdout": true,
		"AttachStderr": true,
		"Cmd":          cmd,
	}
	if len(env) > 0 {
		create["Env"] = env
	}
	createBody, _ := json.Marshal(create)
	var created struct {
		ID string `json:"Id"`
	}
	if err := c.postJSON(ctx, "/containers/"+c.container+"/exec", createBody, &created); err != nil {
		return -1, "", "", fmt.Errorf("exec create: %w", err)
	}

	startBody, _ := json.Marshal(map[string]any{"Detach": false, "Tty": false})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.url("/exec/"+created.ID+"/start"), bytes.NewReader(startBody))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return -1, "", "", fmt.Errorf("exec start: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return -1, "", "", fmt.Errorf("exec start: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	stdout, stderr := demuxStream(resp.Body)

	var inspect struct {
		ExitCode int `json:"ExitCode"`
	}
	if err := c.getJSON(ctx, "/exec/"+created.ID+"/json", &inspect); err != nil {
		return -1, stdout, stderr, fmt.Errorf("exec inspect: %w", err)
	}
	return inspect.ExitCode, stdout, stderr, nil
}

// demuxStream splits the Docker multiplexed stream (8-byte frame headers,
// byte 0 = 1 for stdout, 2 for stderr) into separate stdout and stderr.
func demuxStream(r io.Reader) (string, string) {
	var stdout, stderr bytes.Buffer
	header := make([]byte, 8)
	for {
		if _, err := io.ReadFull(r, header); err != nil {
			break
		}
		size := binary.BigEndian.Uint32(header[4:8])
		if size == 0 {
			continue
		}
		dst := &stdout
		if header[0] == 2 {
			dst = &stderr
		}
		if _, err := io.CopyN(dst, r, int64(size)); err != nil {
			break
		}
	}
	return stdout.String(), stderr.String()
}

func (c *Client) postJSON(ctx context.Context, path string, body []byte, out any) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.url(path), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *Client) getJSON(ctx context.Context, path string, out any) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.url(path), nil)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
