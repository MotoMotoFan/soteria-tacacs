#!/bin/bash
# =============================================================================
# monthly-archive.sh - Monthly AAA log archiving
# =============================================================================
# Company:    Pathfinder Insights
# Engineer:   MotoMotoFan
# Project:    Soteria AAA Infrastructure
# =============================================================================
# Runs on the 1st of every month via cron.
# Compresses all daily log files from the previous month into a single
# YYYY-MM.tar.gz per log type, then removes the original daily files.
#
# Archive structure:
#   /var/log/tac_plus/archive/authentication/2026-01.tar.gz
#   /var/log/tac_plus/archive/authorization/2026-01.tar.gz
#   /var/log/tac_plus/archive/accounting/2026-01.tar.gz
# =============================================================================

set -e

LOG_DIR="/var/log/tac_plus"
ARCHIVE_DIR="${LOG_DIR}/archive"
PROCESS_LOG="${LOG_DIR}/tac_plus-ng.log"

LOG_TYPES=(
    "authentication"
    "authorization"
    "accounting"
)

# =============================================================================
# Functions
# =============================================================================

log() {
    echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] [MONTHLY-ARCHIVE] $1" >> "${PROCESS_LOG}"
}

# =============================================================================
# Main
# =============================================================================

# Calculate previous month and year
PREV_YEAR=$(date -d "last month" '+%Y')
PREV_MONTH=$(date -d "last month" '+%m')
PERIOD="${PREV_YEAR}-${PREV_MONTH}"

log "============================================"
log "Starting monthly archive for ${PERIOD}"
log "============================================"

for LOG_TYPE in "${LOG_TYPES[@]}"; do

    SOURCE_DIR="${LOG_DIR}/${LOG_TYPE}/${PREV_YEAR}/${PREV_MONTH}"
    ARCHIVE_TYPE_DIR="${ARCHIVE_DIR}/${LOG_TYPE}"
    ARCHIVE_FILE="${ARCHIVE_TYPE_DIR}/${PERIOD}.tar.gz"

    # Skip if source directory doesn't exist or is empty
    if [ ! -d "${SOURCE_DIR}" ]; then
        log "  [${LOG_TYPE}] Source directory not found: ${SOURCE_DIR} - skipping."
        continue
    fi

    if [ -z "$(ls -A "${SOURCE_DIR}")" ]; then
        log "  [${LOG_TYPE}] Source directory is empty: ${SOURCE_DIR} - skipping."
        continue
    fi

    # Ensure archive directory exists
    mkdir -p "${ARCHIVE_TYPE_DIR}"

    # Compress all daily files into a single monthly archive
    log "  [${LOG_TYPE}] Compressing ${SOURCE_DIR} -> ${ARCHIVE_FILE}"
    tar -czf "${ARCHIVE_FILE}" -C "${LOG_DIR}/${LOG_TYPE}/${PREV_YEAR}" "${PREV_MONTH}"

    # Verify archive integrity before deleting originals
    if tar -tzf "${ARCHIVE_FILE}" > /dev/null 2>&1; then
        log "  [${LOG_TYPE}] Archive integrity verified."
        # Remove original daily files and the now-empty month directory
        rm -rf "${SOURCE_DIR}"
        log "  [${LOG_TYPE}] Original daily files removed."
    else
        log "  [${LOG_TYPE}] ERROR: Archive integrity check failed! Original files kept."
    fi

done

log "Monthly archive for ${PERIOD} complete."
log "============================================"
