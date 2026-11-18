#!/bin/sh
# Render boot wrapper. Runs as root, prepares the persistent disk, applies
# env-driven config, then drops to the node user and starts the gateway.
# Every step before the final exec is best-effort so a bad optional setting
# can never stop the gateway from starting.

log() { echo "[render-boot] $*" >&2; }

# 1. Disk layout. Render mounts /data group/world-writable; OpenClaw's temp-root
#    check rejects that, so tighten it, then make sure the node user owns the
#    folders it needs (a fresh disk would otherwise fail with EACCES).
chmod go-w /data 2>/dev/null || true
for d in /data/.openclaw /data/workspace /data/.claude; do
  [ -d "$d" ] || install -d -o node -g node -m 700 "$d" || log "could not create $d"
done
chown -R node:node /data/.claude 2>/dev/null || true

# 2. GitHub credentials. Written to a node-only file on the disk; the token is
#    then removed from the environment so the AI's processes never see it as a
#    variable. git finds the file through /etc/gitconfig (set in the image).
if [ -n "${GITHUB_PAT:-}" ]; then
  if ( umask 077 && printf 'https://x-access-token:%s@github.com\n' "$GITHUB_PAT" > /data/.git-credentials ); then
    chown node:node /data/.git-credentials && chmod 600 /data/.git-credentials
    log "GitHub credentials written"
  else
    log "could not write GitHub credentials"
  fi
fi
unset GITHUB_PAT

# 3. Apply config from env vars (model, Discord, approvals, dashboard origin).
cd /app 2>/dev/null || true
runuser -u node -- node /usr/local/lib/render/configure.mjs || log "config step failed; starting gateway anyway"
unset CLAUDE_SETUP_TOKEN

# 4. Start the gateway exactly as before.
exec runuser -u node -- tini -s -- node /app/docker-entrypoint.mjs node openclaw.mjs gateway --allow-unconfigured --bind lan
