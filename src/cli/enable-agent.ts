import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';
import { TelegramAPI, formatValidateError } from '../telegram/api.js';
import { resolveAdapter } from '../channels/registry.js';

/**
 * BUG-035 fix: discover the officeOs framework root without depending on
 * `process.cwd()`. Order of precedence:
 *   1. CTX_FRAMEWORK_ROOT env var (explicit, set by ecosystem.config.js)
 *   2. CTX_PROJECT_ROOT env var (legacy alias)
 *   3. ~/cortextos/ (the canonical install location from install.mjs)
 *   4. process.cwd() (last-resort legacy fallback)
 *
 * Without this, `officeos enable` and similar CLI commands silently fail
 * outside ~/officeos with a misleading "no .env found" error, even when
 * the .env exists at the canonical location. The error message is then
 * misleading because it doesn't list the paths that were checked.
 */
export function discoverProjectRoot(): string {
  if (process.env.CTX_FRAMEWORK_ROOT) return process.env.CTX_FRAMEWORK_ROOT;
  if (process.env.CTX_PROJECT_ROOT) return process.env.CTX_PROJECT_ROOT;
  // Canonical install location (install.mjs always installs to ~/cortextos)
  const canonical = join(homedir(), 'cortextos');
  if (existsSync(join(canonical, 'orgs')) || existsSync(join(canonical, 'agents'))) {
    return canonical;
  }
  return process.cwd();
}

function parseEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const lines = readFileSync(path, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      vars[key] = val;
    }
  } catch { /* unreadable */ }
  return vars;
}

function getEnabledAgentsPath(instanceId: string): string {
  return join(homedir(), '.officeos', instanceId, 'config', 'enabled-agents.json');
}

/**
 * BUG-013 fix: validate enabled-agents.json on read instead of silently
 * returning {} on any error. The original implementation hid two real failure
 * modes from the user:
 *   1. Corrupt JSON (file exists but won't parse) → silently empty, then
 *      writeEnabledAgents() overwrites the corrupt file with {}, destroying
 *      the user's enable state with no warning.
 *   2. Wrong shape (file exists, parses to an array/null/string) → same
 *      silent destruction.
 *
 * The fix backs the bad file up as `enabled-agents.json.broken-<timestamp>`,
 * logs a clear warning to stderr, and returns {} only after preserving the
 * original. Users can recover from a backup, and they know WHY their agents
 * disappeared.
 */
export function readEnabledAgents(instanceId: string): Record<string, any> {
  const path = getEnabledAgentsPath(instanceId);
  if (!existsSync(path)) return {}; // legit: no file = empty state, not an error

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    console.error(`[enable] Failed to read ${path}: ${err}`);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const backup = `${path}.broken-${Date.now()}`;
    try { writeFileSync(backup, raw); } catch { /* ignore backup failure */ }
    console.error(`[enable] WARNING: ${path} contains invalid JSON. Backed up to ${backup}. Treating as empty.`);
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const backup = `${path}.broken-${Date.now()}`;
    try { writeFileSync(backup, raw); } catch { /* ignore backup failure */ }
    console.error(`[enable] WARNING: ${path} is not a JSON object (got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}). Backed up to ${backup}. Treating as empty.`);
    return {};
  }

  return parsed as Record<string, any>;
}

/**
 * BUG-036 fix: write a `.user-disable` marker before the agent's PTY is killed,
 * so the SessionEnd crash-alert hook (src/hooks/hook-crash-alert.ts) knows the
 * disable was intentional and does not fire a false 🚨 CRASH alarm.
 * Pattern matches src/cli/bus.ts:1285-1289.
 */
export function writeDisableMarker(instanceId: string, agent: string, reason: string): void {
  try {
    const ctxRoot = join(homedir(), '.officeos', instanceId);
    const stateDir = join(ctxRoot, 'state', agent);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.user-disable'), reason);
  } catch { /* don't block disable on marker-write failure */ }
}

function writeEnabledAgents(instanceId: string, agents: Record<string, any>): void {
  const path = getEnabledAgentsPath(instanceId);
  const dir = join(homedir(), '.officeos', instanceId, 'config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(agents, null, 2) + '\n', 'utf-8');
}

export const enableAgentCommand = new Command('enable')
  .argument('<agent>', 'Agent name to enable')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--org <org>', 'Organization name')
  .description('Enable an agent (register and start)')
  .action(async (agent: string, options: { instance: string; org?: string }) => {
    // Becky bug preflight: verify .env has BOT_TOKEN and CHAT_ID before registering.
    // Without this, the agent starts, inherits parent-process credentials silently,
    // appears alive on the dashboard but cannot receive any Telegram messages.
    const projectRoot = discoverProjectRoot();

    // Auto-detect org if not specified by scanning orgs/ for this agent
    if (!options.org) {
      const orgsDir = join(projectRoot, 'orgs');
      if (existsSync(orgsDir)) {
        try {
          const { readdirSync } = require('fs');
          const orgs = readdirSync(orgsDir, { withFileTypes: true })
            .filter((d: any) => d.isDirectory())
            .map((d: any) => d.name);
          for (const o of orgs) {
            if (existsSync(join(orgsDir, o, 'agents', agent))) {
              options.org = o;
              break;
            }
          }
        } catch { /* ignore */ }
      }
    }

    const orgDir = options.org ? join(projectRoot, 'orgs', options.org) : null;

    // Locate agent dir — try org-scoped path first, then flat agents/ fallback
    let agentEnvPath: string | null = null;
    if (orgDir) {
      const candidate = join(orgDir, 'agents', agent, '.env');
      if (existsSync(candidate)) agentEnvPath = candidate;
    }
    if (!agentEnvPath) {
      const candidate = join(projectRoot, 'agents', agent, '.env');
      if (existsSync(candidate)) agentEnvPath = candidate;
    }

    if (!agentEnvPath) {
      // BUG-035 fix: list the paths we actually checked so users can debug
      // path-discovery failures without reading the source code.
      console.error(`Error: No .env found for agent "${agent}". Checked:`);
      if (orgDir) console.error(`  - ${join(orgDir, 'agents', agent, '.env')}`);
      console.error(`  - ${join(projectRoot, 'agents', agent, '.env')}`);
      console.error(`Project root: ${projectRoot}`);
      console.error(`(Set CTX_FRAMEWORK_ROOT to override path discovery, or run from inside ~/cortextos.)`);
      console.error(`Create the .env with BOT_TOKEN and CHAT_ID before enabling.`);
      process.exit(1);
    }

    const env = parseEnvFile(agentEnvPath);

    // Adapter-aware preflight: validate whichever channel this agent is wired
    // for. A Slack-facing orchestrator has SLACK_* creds; a Telegram agent has
    // BOT_TOKEN/CHAT_ID. Hard-coding Telegram broke Slack-only onboarding.
    const kind: 'slack' | 'telegram' | null =
      env.SLACK_BOT_TOKEN ? 'slack' : (env.BOT_TOKEN || env.CHAT_ID) ? 'telegram' : null;

    if (!kind) {
      console.error(`Error: .env for agent "${agent}" has no channel configured.`);
      console.error(`Set Slack (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_CHANNEL_ID) or Telegram (BOT_TOKEN, CHAT_ID) in ${agentEnvPath}.`);
      process.exit(1);
    }

    if (kind === 'slack') {
      const missing = (['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_CHANNEL_ID'] as const).filter(k => !env[k]);
      if (missing.length > 0) {
        console.error(`Error: .env for agent "${agent}" (Slack) is missing required values: ${missing.join(', ')}`);
        console.error(`Edit ${agentEnvPath} and set them before enabling.`);
        process.exit(1);
      }
      // Validate the bot token via the Slack adapter (auth.test). Warn-not-block
      // on failure: onboarding already validated the token live, and we don't
      // want a transient Slack API hiccup to block enable.
      try {
        const adapter = resolveAdapter('slack', { botToken: env.SLACK_BOT_TOKEN });
        const res = adapter ? await adapter.validateCredentials() : { ok: true } as { ok: boolean };
        if (res.ok) {
          console.log(`Slack validated: bot ${('identity' in res && res.identity) ? res.identity : 'ok'}, channel ${env.SLACK_CHANNEL_ID}`);
        } else {
          console.error(`Warning: could not verify Slack credentials (${('error' in res && res.error) || 'unknown'}).`);
          console.error('  Continuing enable — re-run after fixing the token if this was not transient.');
        }
      } catch (err) {
        console.error(`Warning: Slack credential validation crashed: ${err instanceof Error ? err.message : String(err)}. Continuing enable.`);
      }
    } else {
      const missing = (['BOT_TOKEN', 'CHAT_ID'] as const).filter(k => !env[k]);
      if (missing.length > 0) {
        console.error(`Error: .env for agent "${agent}" (Telegram) is missing required values: ${missing.join(', ')}`);
        console.error(`Edit ${agentEnvPath} and set BOT_TOKEN and CHAT_ID before enabling.`);
        process.exit(1);
      }
      // self-chat trap preflight: validate BOT_TOKEN + CHAT_ID against the live
      // Telegram API. Hard-fails on config-level reasons (bad_token,
      // chat_not_found, bot_recipient, self_chat); warns but does not block on
      // transient reasons (network_error, rate_limited).
      try {
        const telegramApi = new TelegramAPI(env.BOT_TOKEN);
        const validation = await telegramApi.validateCredentials(env.CHAT_ID);
        if (validation.ok) {
          const label = validation.chatTitle ? ` (${validation.chatTitle})` : '';
          console.log(
            `Telegram validated: bot=@${validation.botUsername} chat=${env.CHAT_ID} type=${validation.chatType}${label}`,
          );
        } else if (validation.reason === 'network_error' || validation.reason === 'rate_limited') {
          console.error(`Warning: could not verify Telegram credentials (${validation.reason}).`);
          console.error(`  ${formatValidateError(validation)}`);
          console.error('  Continuing anyway — re-run enable after connectivity is restored to confirm.');
        } else {
          console.error(`Error: Telegram credentials for agent "${agent}" failed validation.`);
          console.error(`  ${formatValidateError(validation)}`);
          console.error(`  Edit ${agentEnvPath} and re-run: officeos enable ${agent}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Warning: Telegram credential validation crashed: ${err instanceof Error ? err.message : String(err)}`);
        console.error('  Continuing enable. Investigate the validator if this recurs.');
      }
    }

    const agents = readEnabledAgents(options.instance);
    agents[agent] = {
      enabled: true,
      status: 'configured',
      ...(options.org ? { org: options.org } : {}),
    };
    writeEnabledAgents(options.instance, agents);

    // Create per-agent state directories
    const ctxRoot = join(homedir(), '.officeos', options.instance);
    const agentDirs = [
      join(ctxRoot, 'inbox', agent),
      join(ctxRoot, 'inflight', agent),
      join(ctxRoot, 'processed', agent),
      join(ctxRoot, 'outbox', agent),
      join(ctxRoot, 'logs', agent),
      join(ctxRoot, 'state', agent),
    ];
    for (const dir of agentDirs) {
      mkdirSync(dir, { recursive: true });
    }

    console.log(`Agent "${agent}" enabled.`);

    // Try to start via daemon IPC
    const ipc = new IPCClient(options.instance);
    const running = await ipc.isDaemonRunning();
    if (running) {
      const response = await ipc.send({ type: 'start-agent', agent, source: 'officeos enable' });
      if (response.success) {
        console.log(`  Started via daemon: ${response.data}`);
      }
    } else {
      console.log('  Daemon not running. Start with: officeos start');
    }
  });

export const disableAgentCommand = new Command('disable')
  .argument('<agent>', 'Agent name to disable')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Disable an agent (stop and deregister)')
  .action(async (agent: string, options: { instance: string }) => {
    const agents = readEnabledAgents(options.instance);
    if (agents[agent]) {
      agents[agent].enabled = false;
    }
    writeEnabledAgents(options.instance, agents);

    // Try to stop via daemon IPC
    const ipc = new IPCClient(options.instance);
    const running = await ipc.isDaemonRunning();
    if (running) {
      // BUG-036 fix: write .user-disable marker BEFORE the stop, so the
      // SessionEnd crash-alert hook in src/hooks/hook-crash-alert.ts knows
      // this was an intentional disable and not a crash. Without this,
      // the hook defaults to "crash" and the user gets a false 🚨 CRASH alarm.
      // Pattern matches src/cli/bus.ts:1285-1289.
      writeDisableMarker(options.instance, agent, 'disabled via officeos disable');

      const response = await ipc.send({ type: 'stop-agent', agent, source: 'officeos disable' });
      if (response.success) {
        console.log(`Agent "${agent}" disabled and stopped.`);
      } else {
        console.log(`Agent "${agent}" disabled. Stop failed: ${response.error}`);
      }
    } else {
      console.log(`Agent "${agent}" disabled.`);
    }
  });
