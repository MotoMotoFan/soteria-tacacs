// Package netbox is a minimal read-only client for the NetBox IPAM API, used as
// a DNS source of truth. It is intentionally dependency-free. The agent reaches
// NetBox directly by IP with a Host header (the *.lab.home name only resolves on
// clients), Token auth, and optional insecure TLS for the lab's self-signed cert.
package netbox

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	BaseURL string // e.g. https://192.168.1.150
	Host    string // Host header, e.g. netbox.lab.home
	Token   string
	http    *http.Client
}

// New returns a client, or nil if the base URL or token is unset (DNS SoT scan
// then reports unavailable rather than erroring).
func New(baseURL, host, token string, insecure bool) *Client {
	if baseURL == "" || token == "" {
		return nil
	}
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Host:    host,
		Token:   token,
		http: &http.Client{
			Timeout: 20 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: insecure}, //nolint:gosec // lab self-signed cert
			},
		},
	}
}

// Prefix is a NetBox IPAM prefix (CIDR).
type Prefix struct {
	Prefix string
	ID     int
}

// IPEntry is an IP address with its resolved host name.
type IPEntry struct {
	IP         string // bare IP (no mask)
	IsV6       bool
	DNSName    string // NetBox dns_name field (may be empty)
	DeviceName string // assigned device or VM name (may be empty)
}

// Name returns the best available host name: dns_name, else device/VM name.
func (e IPEntry) Name() string {
	if e.DNSName != "" {
		return e.DNSName
	}
	return e.DeviceName
}

// get performs a GET against BaseURL+path, decoding into out. path may be a full
// absolute NetBox URL (pagination "next") - its path+query is reused so requests
// keep hitting BaseURL with the Host header.
func (c *Client) get(ctx context.Context, path string, out any) error {
	reqURL := path
	if strings.HasPrefix(path, "http") {
		if u, err := url.Parse(path); err == nil {
			reqURL = c.BaseURL + u.RequestURI()
		}
	} else {
		reqURL = c.BaseURL + path
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return err
	}
	if c.Host != "" {
		req.Host = c.Host
	}
	req.Header.Set("Authorization", "Token "+c.Token)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("netbox request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var detail struct {
			Detail string `json:"detail"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&detail)
		if detail.Detail != "" {
			return fmt.Errorf("netbox %s: %s", resp.Status, detail.Detail)
		}
		return fmt.Errorf("netbox %s", resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

type prefixResult struct {
	ID     int    `json:"id"`
	Prefix string `json:"prefix"`
}

// PrefixesByTag returns all prefixes carrying the given tag slug.
func (c *Client) PrefixesByTag(ctx context.Context, tag string) ([]Prefix, error) {
	var out []Prefix
	next := "/api/ipam/prefixes/?tag=" + url.QueryEscape(tag) + "&limit=500"
	for next != "" {
		var page struct {
			Next    string         `json:"next"`
			Results []prefixResult `json:"results"`
		}
		if err := c.get(ctx, next, &page); err != nil {
			return nil, err
		}
		for _, p := range page.Results {
			out = append(out, Prefix{Prefix: p.Prefix, ID: p.ID})
		}
		next = page.Next
	}
	return out, nil
}

type ipResult struct {
	Address        string `json:"address"`
	DNSName        string `json:"dns_name"`
	AssignedObject *struct {
		Device *struct {
			Name string `json:"name"`
		} `json:"device"`
		VirtualMachine *struct {
			Name string `json:"name"`
		} `json:"virtual_machine"`
	} `json:"assigned_object"`
}

// IPsInPrefix returns all IP addresses whose parent is the given CIDR.
func (c *Client) IPsInPrefix(ctx context.Context, cidr string) ([]IPEntry, error) {
	var out []IPEntry
	next := "/api/ipam/ip-addresses/?parent=" + url.QueryEscape(cidr) + "&limit=500"
	for next != "" {
		var page struct {
			Next    string     `json:"next"`
			Results []ipResult `json:"results"`
		}
		if err := c.get(ctx, next, &page); err != nil {
			return nil, err
		}
		for _, r := range page.Results {
			ipStr := r.Address
			if i := strings.IndexByte(ipStr, '/'); i >= 0 {
				ipStr = ipStr[:i]
			}
			ip := net.ParseIP(ipStr)
			if ip == nil {
				continue
			}
			e := IPEntry{IP: ipStr, IsV6: ip.To4() == nil, DNSName: strings.TrimSpace(r.DNSName)}
			if r.AssignedObject != nil {
				if r.AssignedObject.Device != nil {
					e.DeviceName = r.AssignedObject.Device.Name
				} else if r.AssignedObject.VirtualMachine != nil {
					e.DeviceName = r.AssignedObject.VirtualMachine.Name
				}
			}
			out = append(out, e)
		}
		next = page.Next
	}
	return out, nil
}
