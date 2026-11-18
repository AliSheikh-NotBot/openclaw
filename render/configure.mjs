// Applies OpenClaw config from Render env vars on every boot, so the whole
// setup can be managed from the Render dashboard without a shell.
// Runs as the node user before the gateway starts. Never prints secret values.
//
// Env vars read (all optional):
//   OPENCLAW_MODEL          default anthropic/claude-sonnet-5-5 (runs via Claude CLI)
//   OPENCLAW_EXEC_MODE      deny | allowlist | ask | auto | full   (default ask)
//   DISCORD_BOT_TOKEN       enables the Discord channel (read by OpenClaw itself)
//   DISCORD_APPLICATION_ID  default: this fork's bot
//   DISCORD_OWNER_ID        your Discord user ID: only you can DM the bot and
//                           approve commands. Without it, DMs use pairing codes.
//   RENDER_EXTERNAL_URL     set by Render; allowed origin for the web dashboard
//   CLAUDE_SETUP_TOKEN      output of `claude setup-token`; saved as the
//                           Anthropic subscription account on each boot
//   OPENCLAW_PLUGINS_DENY   comma list of plugins not to load ("none" = load all)
//   OPENCLAW_RENDER_RECOVER_LOCK=0 disables automatic stale-lock recovery.
//   OPENCLAW_RENDER_CONFIGURE=0 skips this script entirely.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const env = process.env;
const log = (msg) => console.error(`[render-config] ${msg}`);

if (env.OPENCLAW_RENDER_CONFIGURE === "0") {
  log("skipped (OPENCLAW_RENDER_CONFIGURE=0)");
  process.exit(0);
}

const run = (args, input) =>
  spawnSync("openclaw", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

// A gateway that was killed (crash, out-of-memory, forced stop) leaves its state
// lock on the disk, and the next boot then refuses to start. A Render disk is
// attached to one instance at a time and this runs before our own gateway
// starts, so any holder found here is dead: recover it through OpenClaw's own
// inspect-then-confirm flow. Set OPENCLAW_RENDER_RECOVER_LOCK=0 to disable.
if (env.OPENCLAW_RENDER_RECOVER_LOCK !== "0") {
  const inspect = run(["gateway", "recover-lock", "--json"]);
  let info;
  try {
    info = JSON.parse(inspect.stdout.slice(inspect.stdout.indexOf("{")));
  } catch {}
  if (info?.present && info.confirmation) {
    log(`stale gateway lock found (${info.holders?.length ?? 0} records); recovering`);
    const rec = run(["gateway", "recover-lock", "--confirm", info.confirmation]);
    log(rec.status === 0 ? "stale lock recovered" : `lock recovery failed: ${(rec.stderr || rec.stdout || "").trim().slice(-500)}`);
  }
}

// Claude subscription token (from `claude setup-token`). Saving one is an
// offline-only operation, so it has to happen here, before the gateway starts.
// The token goes in over stdin, and boot.sh removes the variable afterwards so
// the gateway and the AI's processes never inherit it.
const setupToken = (env.CLAUDE_SETUP_TOKEN || "").replaceAll(/\s+/g, "");
if (setupToken) {
  const r = run(["models", "auth", "paste-token", "--provider", "anthropic"], setupToken);
  log(
    r.status === 0
      ? "Claude subscription token saved"
      : `saving Claude token failed: ${(r.stderr || r.stdout || "").split(setupToken).join("<token>").trim().slice(-500)}`,
  );
}

const model = (env.OPENCLAW_MODEL || "anthropic/claude-sonnet-5-5").trim();
const execMode = (env.OPENCLAW_EXEC_MODE || "ask").trim();
const ownerId = (env.DISCORD_OWNER_ID || "").trim().replace(/^discord:/, "");
const appId = (env.DISCORD_APPLICATION_ID || "1484358568067989574").trim();
const origin = (env.RENDER_EXTERNAL_URL || "").trim().replace(/\/+$/, "");

const patch = {
  agents: {
    defaults: {
      model: { primary: model },
      models: { [model]: { agentRuntime: { id: "claude-cli" } } },
    },
  },
  tools: { exec: { mode: execMode } },
  // Plugins this deployment never uses. Each loaded plugin costs memory on a
  // 2GB instance that also has to fit Claude Code. Override with a
  // comma-separated OPENCLAW_PLUGINS_DENY (set it to "none" to load all).
  plugins: { deny: denyList() },
};

function denyList() {
  const raw = (env.OPENCLAW_PLUGINS_DENY || "").trim();
  if (raw === "none") return [];
  if (raw) return raw.split(/[\s,]+/).filter(Boolean);
  return [
    "browser", "canvas", "cua-computer", "geolocation", "talk-voice",
    "ollama", "openai", "xai", "file-transfer",
  ];
}

if (origin) {
  patch.gateway = { controlUi: { allowedOrigins: [origin] } };
}

if (env.DISCORD_BOT_TOKEN && env.DISCORD_BOT_TOKEN.trim()) {
  const discord = {
    enabled: true,
    token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
    applicationId: appId,
  };
  if (/^\d{5,25}$/.test(ownerId)) {
    discord.dmPolicy = "allowlist";
    discord.allowFrom = [`discord:${ownerId}`];
    discord.execApprovals = { enabled: true, approvers: [ownerId], target: "dm" };
    patch.commands = { ownerAllowFrom: [`discord:user:${ownerId}`] };
  } else if (ownerId) {
    log("DISCORD_OWNER_ID is not a numeric Discord user ID; ignoring it");
  }
  patch.channels = { discord };
}

const res = run(["config", "patch", "--stdin"], JSON.stringify(patch));
if (res.status !== 0) {
  log(`config patch failed (exit ${res.status}):\n${(res.stderr || res.stdout || "").slice(-2000)}`);
  process.exit(1);
}
log(
  `applied: model=${model} runtime=claude-cli exec=${execMode}` +
    ` discord=${patch.channels ? "on" : "off"}` +
    ` owner=${patch.commands ? "set" : "unset"} dashboardOrigin=${origin || "unset"}`,
);

// Commands the AI may run without asking you first (ask mode only). Everything
// else sends you an approval prompt in Discord. Resolved to absolute paths.
if (execMode === "ask") {
  const safe = [
    "git", "ls", "cat", "head", "tail", "wc", "grep", "find", "pwd", "echo",
    "node", "npm", "npx", "pnpm", "mkdir", "diff", "sort", "which",
  ];
  const marker = `${env.OPENCLAW_STATE_DIR || "/data/.openclaw"}/.render-allowlist-v1`;
  if (!fs.existsSync(marker)) {
    let added = 0;
    for (const bin of safe) {
      const which = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
      const path = (which.stdout || "").trim();
      if (!path.startsWith("/")) continue;
      const r = run(["approvals", "allowlist", "add", "--agent", "main", path]);
      if (r.status === 0) added += 1;
      else log(`allowlist add ${bin} failed: ${(r.stderr || "").trim().slice(-300)}`);
    }
    try {
      fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
    } catch {}
    log(`exec allowlist: ${added} commands pre-approved`);
  }
}
