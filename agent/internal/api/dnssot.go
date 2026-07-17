package api

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Pathfinder-Insights/soteria-agent/internal/dns"
)

// validDNS rejects owner labels / hostname values that would break the zone
// file (whitespace, control chars, etc.). NetBox names are free-form, so any
// entry that fails this is skipped rather than corrupting the zone.
var validDNSRe = regexp.MustCompile(`^[A-Za-z0-9_.@*-]+$`)

func validDNS(s string) bool { return s != "" && validDNSRe.MatchString(s) }

func (s *Server) sotReady(w http.ResponseWriter) bool {
	if !s.dnsReady(w) {
		return false
	}
	if s.NB == nil {
		writeError(w, http.StatusFailedDependency,
			fmt.Errorf("NetBox source of truth is not configured (set AGENT_NETBOX_URL/TOKEN on the agent)"))
		return false
	}
	return true
}

// scanReverseZones creates a reverse zone for every NetBox prefix carrying the
// given tag.
func (s *Server) scanReverseZones(w http.ResponseWriter, r *http.Request) {
	if !s.sotReady(w) {
		return
	}
	var body struct {
		Tag    string `json:"tag"`
		DryRun bool   `json:"dryRun"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Tag) == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("a tag is required"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	prefixes, err := s.NB.PrefixesByTag(ctx, body.Tag)
	if err != nil {
		writeError(w, http.StatusFailedDependency, err)
		return
	}
	existing := map[string]bool{}
	if zs, zerr := s.DNS.Zones(ctx); zerr == nil {
		for _, z := range zs {
			existing[z.Name] = true
		}
	}
	// Plan first: classify without creating anything. Initialise non-nil so the
	// JSON is always [] not null (a nil slice marshals to null, which crashes
	// the UI's plan.toCreate.length / .join()).
	toCreate, already, skipped := []string{}, []string{}, []string{}
	seen := map[string]bool{}
	for _, p := range prefixes {
		rev, ok := dns.ReverseZoneName(p.Prefix)
		if !ok {
			skipped = append(skipped, p.Prefix) // not a /8, /16 or /24
			continue
		}
		if seen[rev] {
			continue
		}
		seen[rev] = true
		if existing[rev] {
			already = append(already, rev)
		} else {
			toCreate = append(toCreate, rev)
		}
	}

	created, errs := []string{}, []string{}
	if !body.DryRun {
		for _, rev := range toCreate {
			switch err := s.DNS.CreateZone(ctx, dns.Zone{Name: rev}); {
			case err == nil:
				created = append(created, rev)
			case strings.Contains(err.Error(), "already exists"):
				already = append(already, rev)
			default:
				errs = append(errs, fmt.Sprintf("%s: %v", rev, err))
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"dryRun":          body.DryRun,
		"scannedPrefixes": len(prefixes),
		"toCreate":        toCreate,
		"existing":        already,
		"skipped":         skipped,
		"created":         created,
		"errors":          errs,
	})
}

// fqdn makes name an absolute FQDN. A name that already contains a dot is
// treated as an FQDN; a bare name gets the domain appended.
func fqdn(name, domain string) string {
	name = strings.TrimSuffix(strings.TrimSpace(name), ".")
	if name == "" {
		return ""
	}
	if strings.Contains(name, ".") {
		return name + "."
	}
	if domain != "" {
		return name + "." + strings.TrimSuffix(domain, ".") + "."
	}
	return name + "."
}

// forwardOwner returns the owner label for a forward A/AAAA record in zoneName.
// An FQDN under the zone becomes relative; a bare name is used as-is; an FQDN
// under a different domain is skipped (returns "").
func forwardOwner(name, zoneName string) string {
	name = strings.TrimSuffix(strings.TrimSpace(name), ".")
	if name == "" {
		return ""
	}
	if name == zoneName {
		return "@"
	}
	if strings.HasSuffix(name, "."+zoneName) {
		return strings.TrimSuffix(name, "."+zoneName)
	}
	if strings.Contains(name, ".") {
		return "" // FQDN under a different domain
	}
	return name
}

// upsert replaces a same-name+type record or appends it; returns the list and
// whether it was an update.
func upsert(records []dns.Record, rec dns.Record) ([]dns.Record, bool) {
	for i := range records {
		if records[i].Name == rec.Name && records[i].Type == rec.Type {
			records[i].Value = rec.Value
			return records, true
		}
	}
	return append(records, rec), false
}

// syncZoneFromSot pulls IPs from NetBox and merges records into the zone:
// reverse zones get PTR records; forward zones get A/AAAA records.
func (s *Server) syncZoneFromSot(w http.ResponseWriter, r *http.Request) {
	if !s.sotReady(w) {
		return
	}
	name := r.PathValue("name")
	var body struct {
		Tag    string `json:"tag"`
		Domain string `json:"domain"`
		DryRun bool   `json:"dryRun"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	zone, err := s.DNS.Zone(ctx, name)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	records := zone.Records
	skipped := 0
	var addedRecs, updatedRecs []dns.Record

	if zone.Kind == "reverse" {
		network := dns.NetworkOf(name)
		if network == "" {
			writeError(w, http.StatusBadRequest, fmt.Errorf("cannot derive a network CIDR from %q", name))
			return
		}
		ips, err := s.NB.IPsInPrefix(ctx, network)
		if err != nil {
			writeError(w, http.StatusFailedDependency, err)
			return
		}
		for _, ip := range ips {
			if ip.IsV6 {
				continue // IPv4 reverse only for now
			}
			value := fqdn(ip.Name(), body.Domain)
			if value == "" || !validDNS(value) {
				skipped++
				continue
			}
			rec := dns.Record{Name: dns.PtrOwner(ip.IP, name), Type: "PTR", Value: value}
			var wasUpdate bool
			records, wasUpdate = upsert(records, rec)
			if wasUpdate {
				updatedRecs = append(updatedRecs, rec)
			} else {
				addedRecs = append(addedRecs, rec)
			}
		}
	} else {
		if strings.TrimSpace(body.Tag) == "" {
			writeError(w, http.StatusBadRequest, fmt.Errorf("a tag is required for forward zones"))
			return
		}
		prefixes, err := s.NB.PrefixesByTag(ctx, body.Tag)
		if err != nil {
			writeError(w, http.StatusFailedDependency, err)
			return
		}
		for _, p := range prefixes {
			ips, err := s.NB.IPsInPrefix(ctx, p.Prefix)
			if err != nil {
				writeError(w, http.StatusFailedDependency, err)
				return
			}
			for _, ip := range ips {
				owner := forwardOwner(ip.Name(), name)
				if owner == "" || !validDNS(owner) {
					skipped++
					continue
				}
				rtype := "A"
				if ip.IsV6 {
					rtype = "AAAA"
				}
				rec := dns.Record{Name: owner, Type: rtype, Value: ip.IP}
				var wasUpdate bool
				records, wasUpdate = upsert(records, rec)
				if wasUpdate {
					updatedRecs = append(updatedRecs, rec)
				} else {
					addedRecs = append(addedRecs, rec)
				}
			}
		}
	}

	if addedRecs == nil {
		addedRecs = []dns.Record{}
	}
	if updatedRecs == nil {
		updatedRecs = []dns.Record{}
	}
	// Preview: report the planned changes without writing anything.
	if body.DryRun {
		writeJSON(w, http.StatusOK, map[string]any{"dryRun": true, "added": addedRecs, "updated": updatedRecs, "skipped": skipped})
		return
	}
	if len(addedRecs) == 0 && len(updatedRecs) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"dryRun": false, "added": addedRecs, "updated": updatedRecs, "skipped": skipped})
		return
	}
	if err := s.DNS.ReplaceRecords(ctx, name, records); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"dryRun": false, "added": addedRecs, "updated": updatedRecs, "skipped": skipped})
}
