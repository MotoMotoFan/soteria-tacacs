# =============================================================================
# Soteria TACACS+ Server - Dockerfile
# =============================================================================
# Company:    Pathfinder Insights
# Engineer:   MotoMotoFan
# Project:    Soteria AAA Infrastructure
# =============================================================================
# Single-stage build: compile tac_plus-ng from source, then clean up build deps.
# This avoids shared library issues with multi-stage COPY.
# =============================================================================
FROM ubuntu:24.04

LABEL maintainer="MotoMotoFan"
LABEL org.opencontainers.image.vendor="Pathfinder Insights"
LABEL org.opencontainers.image.title="Soteria TACACS+ Server"
LABEL org.opencontainers.image.description="Container-ready TACACS+ server powering Soteria AAA infrastructure"
LABEL org.opencontainers.image.source="https://github.com/Pathfinder-Insights/soteria"

# =============================================================================
# Install build + runtime dependencies
# =============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    clang \
    make \
    cmake \
    libpcre2-dev \
    libssl-dev \
    libcurl4-openssl-dev \
    libldap2-dev \
    libpam0g-dev \
    libsctp-dev \
    zlib1g-dev \
    libradcli-dev \
    libkrb5-dev \
    libc-ares-dev \
    perl \
    cpanminus \
    libnet-ldap-perl \
    libnet-ip-perl \
    libio-socket-ssl-perl \
    logrotate \
    cron \
    gettext-base \
    net-tools \
    fping \
    tcpdump \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Install Perl modules and compile tac_plus-ng
# =============================================================================
RUN cpanm --notest Net::TacacsPlus

COPY binaries/ /build/
WORKDIR /build
RUN chmod +x configure && ./configure tac_plus-ng && make && make install

# Compile and install Scm module + tactrace.pl
WORKDIR /build/spawnd/perl
RUN perl Makefile.PL && make && make install
WORKDIR /build/tac_plus-ng/perl
RUN install -m 0755 tactrace.pl /usr/local/bin/tactrace.pl

# Update shared library cache
RUN ldconfig

# Clean up build sources
RUN rm -rf /build

# =============================================================================
# Configuration and runtime setup
# =============================================================================

# Bake config files into defaults directory
# On first run, entrypoint copies these to the config volume if empty.
# When using the agent, config is pushed from the cloud control plane.
COPY config/tac_plus-ng.cfg              /etc/tac_plus-ng-defaults/tac_plus-ng.cfg
COPY config/conf.d/01-logging.cfg        /etc/tac_plus-ng-defaults/conf.d/01-logging.cfg
COPY config/conf.d/02-dns.cfg            /etc/tac_plus-ng-defaults/conf.d/02-dns.cfg
COPY config/conf.d/03-mavis.cfg          /etc/tac_plus-ng-defaults/conf.d/03-mavis.cfg
COPY config/conf.d/04-devices.cfg        /etc/tac_plus-ng-defaults/conf.d/04-devices.cfg
COPY config/conf.d/05-local-users.cfg    /etc/tac_plus-ng-defaults/conf.d/05-local-users.cfg
COPY config/conf.d/06-groups.cfg         /etc/tac_plus-ng-defaults/conf.d/06-groups.cfg
COPY config/conf.d/07-profiles.cfg       /etc/tac_plus-ng-defaults/conf.d/07-profiles.cfg
COPY config/conf.d/08-ruleset.cfg        /etc/tac_plus-ng-defaults/conf.d/08-ruleset.cfg
COPY config/conf.d/09-tls.cfg            /etc/tac_plus-ng-defaults/conf.d/09-tls.cfg

# Copy logrotate config and scripts
COPY config/logrotate.conf               /etc/logrotate.d/tac_plus-ng
COPY scripts/entrypoint.sh               /usr/local/bin/entrypoint.sh
COPY scripts/monthly-archive.sh          /usr/local/bin/monthly-archive.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/monthly-archive.sh

# Create dedicated service user for tac_plus-ng
RUN groupadd -r tacacs && useradd -r -g tacacs -d /nonexistent -s /usr/sbin/nologin tacacs

# Create log, cache, and TLS directories with strict ownership
RUN mkdir -p \
    /var/log/tac_plus/authorization \
    /var/log/tac_plus/accounting \
    /var/log/tac_plus/authentication \
    /var/log/tac_plus/archive \
    /etc/tac_plus-ng/conf.d \
    /etc/tac_plus-ng/tls \
    /tmp/tacinfo \
    && chown -R tacacs:tacacs /var/log/tac_plus \
    && chown -R tacacs:tacacs /tmp/tacinfo \
    && chmod 750 /var/log/tac_plus \
    && chmod 640 /etc/tac_plus-ng-defaults/tac_plus-ng.cfg \
    && chmod 640 /etc/tac_plus-ng-defaults/conf.d/*.cfg \
    && chmod 700 /etc/tac_plus-ng/tls

# Expose TACACS+ port (49) and TACACS+ over TLS port (300)
EXPOSE 49/tcp
EXPOSE 300/tcp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
