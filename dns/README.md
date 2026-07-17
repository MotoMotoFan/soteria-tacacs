# BIND9 (Soteria lab DNS)

Authoritative-only DNS. Serves:
- **Forward:** `soteria.local` (`zones/db.soteria.local`)
- **Reverse:** `192.168.1.0/24` PTR (`zones/db.192.168.1`)

Recursion is **disabled** (this is not a general resolver; it only answers for the
zones above). Listens on `192.168.1.160:53` (udp+tcp) so it never collides with
the host's `systemd-resolved` loopback stub on `127.0.0.53`.

## Manage
```bash
cd /docker-projects/bind9
docker compose up -d          # start / apply compose changes
docker compose logs -f bind9  # view logs

# After editing a zone file: bump its SOA Serial (YYYYMMDDnn), then reload:
docker exec bind9 rndc reload 2>/dev/null || docker compose restart bind9
```

## Add a record
1. Add an `A` line to `zones/db.soteria.local` (and a matching `PTR` in
   `zones/db.192.168.1` if you want reverse).
2. **Bump the Serial** in that zone's SOA.
3. Reload (see above).

## Test
```bash
dig @192.168.1.160 tacacs.soteria.local +short      # forward
dig @192.168.1.160 -x 192.168.1.160 +short          # reverse
```

## Point clients at it
Add `nameserver 192.168.1.160` (or set your DHCP/router DNS). This server only
resolves `soteria.local` and the reverse zone; keep another resolver for the
internet since recursion is off.
