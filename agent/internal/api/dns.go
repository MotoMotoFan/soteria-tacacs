package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/Pathfinder-Insights/soteria-agent/internal/dns"
)

func (s *Server) dnsReady(w http.ResponseWriter) bool {
	if s.DNS == nil {
		writeError(w, http.StatusServiceUnavailable,
			fmt.Errorf("DNS management is not configured (the bind9 project is not mounted into the agent)"))
		return false
	}
	return true
}

func (s *Server) getDNSZones(w http.ResponseWriter, r *http.Request) {
	if !s.dnsReady(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	zones, err := s.DNS.Zones(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if zones == nil {
		zones = []dns.Zone{} // never emit JSON null; the UI maps over this
	}
	writeJSON(w, http.StatusOK, zones)
}

func (s *Server) getDNSZone(w http.ResponseWriter, r *http.Request) {
	if !s.dnsReady(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	z, err := s.DNS.Zone(ctx, r.PathValue("name"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, z)
}

func (s *Server) createDNSZone(w http.ResponseWriter, r *http.Request) {
	if !s.dnsReady(w) {
		return
	}
	var z dns.Zone
	if !decodeBody(w, r, &z) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.DNS.CreateZone(ctx, z); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "created", "zone": z.Name})
}

func (s *Server) deleteDNSZone(w http.ResponseWriter, r *http.Request) {
	if !s.dnsReady(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.DNS.DeleteZone(ctx, r.PathValue("name")); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Server) putDNSRecords(w http.ResponseWriter, r *http.Request) {
	if !s.dnsReady(w) {
		return
	}
	var records []dns.Record
	if !decodeBody(w, r, &records) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.DNS.ReplaceRecords(ctx, r.PathValue("name"), records); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}
