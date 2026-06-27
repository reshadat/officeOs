/**
 * officeos onboard — interactive Slack-first setup wizard.
 *
 * Builds a full office: one or more teams (orgs), each with a Slack-facing
 * orchestrator and any number of specialists. Marks shared agents, wires the
 * Slack hooks into each orchestrator's settings.json, syncs the JD registry,
 * generates the PM2 ecosystem, and starts the daemon.
 *
 * Flow:
 *   1. Install (deps + state dirs)
 *   2. Per team: create org → orchestrator + Slack creds → specialists (JD, shared)
 *   3. Wire Slack hooks into each orchestrator
 *   4. sync-jds (propagates shared agents across teams)
 *   5. ecosystem + daemon start
 *
 * Telegram remains available via the older `officeos setup` wizard.
 */
import { Command } from 'commander';
import { createInterface, type Interface } from 'readline';
import { existsSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { resolveAdapter } from '../channels/registry.js';
import { validateAgentName, validateOrgName } from '../utils/validate.js';

// ─── Prompt helpers ─────────────────────────────────────────────────────────

function rl(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(iface: Interface, question: string): Promise<string> {
  return new Promise(resolve => iface.question(question, a => resolve(a.trim())));
}

function askRequired(iface: Interface, question: string, errorMsg: string): Promise<string> {
  return new Promise(async resolve => {
    while (true) {
      const answer = await ask(iface, question);
      if (answer) return resolve(answer);
      console.log(`  ${errorMsg}`);
    }
  });
}

function askDefault(iface: Interface, question: string, defaultVal: string): Promise<string> {
  return new Promise(resolve =>
    iface.question(`${question} [${defaultVal}]: `, a => resolve(a.trim() || defaultVal))
  );
}

function askYN(iface: Interface, question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  return new Promise(resolve =>
    iface.question(`${question} [${hint}]: `, a => {
      const v = a.trim().toLowerCase();
      if (!v) return resolve(defaultYes);
      resolve(v === 'y' || v === 'yes');
    })
  );
}

async function askValidName(
  iface: Interface,
  prompt: string,
  validate: (s: string) => void,
  taken: string[] = [],
): Promise<string> {
  while (true) {
    const name = await askRequired(iface, prompt, 'Name cannot be empty.');
    try {
      validate(name);
    } catch {
      console.log('  Invalid name. Use lowercase letters, numbers, hyphens, and underscores only.');
      continue;
    }
    if (taken.includes(name)) {
      console.log(`  "${name}" is already taken in this office. Names must be unique across all teams.`);
      continue;
    }
    return name;
  }
}

// ─── CLI delegation ─────────────────────────────────────────────────────────

function runCli(cwd: string, args: string[], label: string): boolean {
  const cliPath = join(cwd, 'dist', 'cli.js');
  // stdin is 'ignore' so a sub-CLI never drains the wizard's own stdin (the
  // readline answer stream). Sub-commands are non-interactive.
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  if (result.status !== 0) {
    console.error(`\n  Error during: ${label}`);
    return false;
  }
  return true;
}

function findProjectRoot(): string {
  if (process.env.CTX_FRAMEWORK_ROOT && existsSync(join(process.env.CTX_FRAMEWORK_ROOT, 'dist', 'cli.js'))) {
    return process.env.CTX_FRAMEWORK_ROOT;
  }
  const cwd = process.cwd();
  if (existsSync(join(cwd, 'dist', 'cli.js'))) return cwd;
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const { name } = JSON.parse(readFileSync(pkg, 'utf-8'));
        if (name === 'cortextos' && existsSync(join(dir, 'dist', 'cli.js'))) return dir;
      } catch { /* ignore */ }
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

// ─── Slack ──────────────────────────────────────────────────────────────────

export interface SlackCreds {
  botToken: string;
  appToken: string;
  userId: string;
  channelId: string;
  allowedDomains?: string;
}

/**
 * Probe a bot token against auth.test before writing it. Returns the bot's own
 * user id on success (so we can warn if the owner accidentally used it as
 * SLACK_USER_ID), or null on failure. Network errors warn-and-continue.
 */
export async function validateBotToken(botToken: string): Promise<{ ok: boolean; botUserId: string | null }> {
  // Routes through the channel adapter — Slack by default, MockAdapter when
  // OFFICEOS_CHANNEL_ADAPTER=mock (the black-box E2E path).
  const adapter = resolveAdapter('slack', { botToken });
  const res = await adapter.validateCredentials();
  if (res.ok) {
    const id = res.identity ?? null;
    if (id) console.log(`  Validated bot token — bot identity ${id}`);
    else console.log('  Bot token accepted (no identity returned).');
    return { ok: true, botUserId: id };
  }
  console.log(`  Warning: could not validate bot token (${res.error ?? 'unknown'}). Writing .env unvalidated.`);
  // Non-fatal — a network blip shouldn't block setup; daemon preflight re-checks.
  return { ok: true, botUserId: null };
}

async function collectSlackCreds(
  iface: Interface,
  reuse: SlackCreds | null,
): Promise<SlackCreds> {
  console.log('\n  Connect Slack. Create an app at api.slack.com/apps (Socket Mode on).');
  console.log('  See SETUP.md for the exact scopes and event subscriptions.\n');

  let botToken: string;
  let appToken: string;
  if (reuse) {
    const same = await askYN(iface, '  Reuse the same Slack app/bot as the previous team?', true);
    if (same) {
      botToken = reuse.botToken;
      appToken = reuse.appToken;
      console.log('  Reusing the same bot token + app token. This team just gets its own channel.');
    } else {
      botToken = await askRequired(iface, '  Bot token (xoxb-...): ', 'Bot token is required.');
      appToken = await askRequired(iface, '  App-level token (xapp-...): ', 'App token is required.');
    }
  } else {
    botToken = await askRequired(iface, '  Bot token (xoxb-...): ', 'Bot token is required.');
    appToken = await askRequired(iface, '  App-level token (xapp-...): ', 'App token is required.');
  }

  const { botUserId } = await validateBotToken(botToken);

  let userId: string;
  while (true) {
    userId = reuse
      ? await askDefault(iface, '  Your Slack user id (U... — the owner who can approve)', reuse.userId)
      : await askRequired(iface, '  Your Slack user id (U... — the owner who can approve): ', 'User id is required — the daemon refuses to start without an owner.');
    if (botUserId && userId === botUserId) {
      console.log('  That is the bot\'s own user id, not yours. Use your personal U... id (Profile → More → Copy member ID).');
      continue;
    }
    if (!/^[UW][A-Z0-9]+$/.test(userId)) {
      console.log('  That does not look like a Slack user id (expected U... or W...). Re-enter.');
      continue;
    }
    break;
  }

  let channelId: string;
  while (true) {
    channelId = await askRequired(iface, '  Channel id for this team (C...): ', 'Channel id is required.');
    if (!/^[CGD][A-Z0-9]+$/.test(channelId)) {
      console.log('  That does not look like a Slack channel id (expected C..., G..., or D...). Re-enter.');
      continue;
    }
    break;
  }

  let allowedDomains: string | undefined;
  const gate = await askYN(iface, '  Restrict to a company email domain? (blocks guest accounts)', false);
  if (gate) {
    allowedDomains = await askRequired(iface, '  Allowed domain(s), comma-separated (e.g. acme.com): ', 'Enter at least one domain.');
  }

  return { botToken, appToken, userId, channelId, allowedDomains };
}

export function writeSlackEnv(agentDir: string, c: SlackCreds): void {
  const lines = [
    `SLACK_BOT_TOKEN=${c.botToken}`,
    `SLACK_APP_TOKEN=${c.appToken}`,
    `SLACK_USER_ID=${c.userId}`,
    `SLACK_CHANNEL_ID=${c.channelId}`,
  ];
  if (c.allowedDomains) lines.push(`SLACK_ALLOWED_DOMAINS=${c.allowedDomains}`);
  const envPath = join(agentDir, '.env');
  writeFileSync(envPath, lines.join('\n') + '\n', 'utf-8');
  try { chmodSync(envPath, 0o600); } catch { /* ignore on Windows */ }
}

/**
 * Replace the orchestrator's hooks block (Telegram by default in the template)
 * with the Slack hook set. Mirrors the template's event-name structure exactly
 * — only the channel-specific commands change — so it stays correct for this
 * runtime's hook contract. Preserves the permissions block untouched.
 */
export function wireSlackHooks(agentDir: string, projectRoot: string): boolean {
  const settingsPath = join(agentDir, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    console.log(`  Warning: no settings.json at ${settingsPath} — skipping hook wiring.`);
    return false;
  }
  const slack = (name: string) => `node ${join(projectRoot, 'dist', 'hooks', name)}`;
  let settings: any;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    console.log('  Warning: settings.json is not valid JSON — skipping hook wiring.');
    return false;
  }
  settings.hooks = {
    PermissionRequest: [
      { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: slack('hook-planmode-slack.js'), timeout: 1860 }] },
      { hooks: [{ type: 'command', command: slack('hook-permission-slack.js'), timeout: 1860 }] },
    ],
    PreToolUse: [
      { hooks: [{ type: 'command', command: 'cortextos bus hook-loop-detector', timeout: 5 }] },
      { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: slack('hook-ask-slack.js'), timeout: 10 }] },
    ],
    SessionEnd: [
      { hooks: [{ type: 'command', command: 'cortextos crash-alert', timeout: 10 }] },
      { hooks: [{ type: 'command', command: slack('hook-crash-alert-slack.js'), timeout: 10 }] },
    ],
    PreCompact: [
      { hooks: [{ type: 'command', command: slack('hook-compact-slack.js'), timeout: 10 }] },
    ],
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  console.log('  Wired Slack hooks into settings.json.');
  return true;
}

/** Patch the empty jd placeholder in an agent's config.json. */
export function patchJD(agentDir: string, title: string, description: string, shared: boolean): void {
  const configPath = join(agentDir, 'config.json');
  if (!existsSync(configPath)) return;
  let config: any;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return;
  }
  config.jd = {
    ...(config.jd ?? {}),
    title,
    description,
    responsibilities: config.jd?.responsibilities ?? [],
    provides: config.jd?.provides ?? [],
    needs: config.jd?.needs ?? [],
    keywords: config.jd?.keywords ?? [],
    out_of_scope: config.jd?.out_of_scope ?? [],
    ...(shared ? { shared: true } : {}),
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

// ─── Wizard ─────────────────────────────────────────────────────────────────

export const onboardCommand = new Command('onboard')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--skip-install', 'Skip the dependency-install step (tests)')
  .option('--no-start', 'Skip starting the daemon (tests)')
  .option('--skip-enable', 'Skip enabling agents in the daemon (tests)')
  .description('Interactive Slack-first setup — build teams, connect Slack, wire hooks, start the daemon')
  .action(async (options: { instance: string; skipInstall?: boolean; start?: boolean; skipEnable?: boolean }) => {
    const instanceId = options.instance;
    // Test seams — flags OR env so a spawned wizard can be driven non-destructively.
    const skipInstall = options.skipInstall || process.env.OFFICEOS_ONBOARD_SKIP_INSTALL === '1';
    const noStart = options.start === false || process.env.OFFICEOS_ONBOARD_NO_START === '1';
    const skipEnable = options.skipEnable || process.env.OFFICEOS_ONBOARD_SKIP_ENABLE === '1';
    const projectRoot = findProjectRoot();
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    const iface = rl();

    console.log('\n  Welcome to officeOs onboarding\n');
    console.log('  This builds your office: teams of agents you control from Slack.');
    console.log('    1. Install dependencies + state');
    console.log('    2. Create teams — each with a Slack-facing orchestrator + specialists');
    console.log('    3. Wire Slack hooks and sync the JD registry');
    console.log('    4. Start the daemon\n');
    console.log('  Press Ctrl+C any time to exit.\n');
    console.log('  ─────────────────────────────────────\n');

    // ─── Step 1: install ──────────────────────────────────────────────────────
    console.log('  Step 1: Checking dependencies and creating state directories...\n');
    if (skipInstall) {
      console.log('  Skipping install (--skip-install).\n');
    } else if (!runCli(projectRoot, ['install', '--instance', instanceId], 'officeos install')) {
      console.error('\n  Install failed. Fix the errors above and re-run officeos onboard.');
      iface.close();
      process.exit(1);
    }

    const allAgentNames: string[] = [];
    const teams: Array<{ org: string; orch: string; specialists: string[] }> = [];
    let sharedCreds: SlackCreds | null = null;
    let teamNum = 0;

    // ─── Step 2: team loop ────────────────────────────────────────────────────
    while (true) {
      teamNum++;
      const first = teamNum === 1;
      console.log('\n  ─────────────────────────────────────\n');
      console.log(`  Team ${teamNum}${first ? '' : ' (additional)'}\n`);
      console.log('  A team is an org with its own orchestrator. Examples: docs, marketing, eng.\n');

      const org = await askValidName(iface, '  Team / org name: ', validateOrgName);
      if (!runCli(projectRoot, ['init', org, '--instance', instanceId], `officeos init ${org}`)) {
        console.error('\n  Org creation failed.');
        iface.close();
        process.exit(1);
      }

      // Orchestrator
      console.log('\n  The orchestrator is the only agent you talk to in Slack. It routes to specialists.\n');
      const orchName = await askValidName(
        iface,
        `  Orchestrator name (e.g. ${org}-orch): `,
        validateAgentName,
        allAgentNames,
      );

      const creds = await collectSlackCreds(iface, sharedCreds);
      if (!sharedCreds) sharedCreds = creds;

      if (!runCli(projectRoot, ['add-agent', orchName, '--template', 'orchestrator', '--org', org, '--instance', instanceId], `add-agent ${orchName}`)) {
        console.error('\n  Failed to create orchestrator.');
        iface.close();
        process.exit(1);
      }
      const orchDir = join(projectRoot, 'orgs', org, 'agents', orchName);
      writeSlackEnv(orchDir, creds);
      console.log(`  Wrote Slack .env for ${orchName}`);
      wireSlackHooks(orchDir, projectRoot);
      patchJD(orchDir, `${org} orchestrator`, `Routes ${org} team requests to the right specialist.`, false);
      if (!skipEnable) runCli(projectRoot, ['enable', orchName, '--org', org, '--instance', instanceId], `enable ${orchName}`);
      allAgentNames.push(orchName);

      // Specialists
      const specialists: string[] = [];
      console.log('\n  Now add specialists to this team (doc-writer, analyst, codebase-agent, ...).');
      while (true) {
        if (!(await askYN(iface, '\n  Add a specialist to this team?', specialists.length === 0))) break;

        const name = await askValidName(iface, '  Specialist name: ', validateAgentName, allAgentNames);
        const template = 'agent';
        const title = await askRequired(iface, '  One-line title (e.g. "Documentation Specialist"): ', 'Title helps routing.');
        const description = await askRequired(iface, '  What does it handle? (one sentence): ', 'A description helps the orchestrator route to it.');
        const shared = await askYN(iface, '  Share this agent across all teams? (other orchestrators can route to it)', false);

        if (!runCli(projectRoot, ['add-agent', name, '--template', template, '--org', org, '--instance', instanceId], `add-agent ${name}`)) {
          console.log(`  Skipping ${name}.`);
          continue;
        }
        const dir = join(projectRoot, 'orgs', org, 'agents', name);
        patchJD(dir, title, description, shared);
        if (!skipEnable) runCli(projectRoot, ['enable', name, '--org', org, '--instance', instanceId], `enable ${name}`);
        specialists.push(name);
        allAgentNames.push(name);
        console.log(`  Added ${name}${shared ? ' (shared)' : ''}.`);
      }

      teams.push({ org, orch: orchName, specialists });

      if (!(await askYN(iface, '\n  Add another team?', false))) break;
    }

    // ─── Step 3: sync JD registry ─────────────────────────────────────────────
    console.log('\n  ─────────────────────────────────────\n');
    console.log('  Step 3: Syncing the JD registry (propagating shared agents)...\n');
    runCli(projectRoot, ['sync-jds'], 'officeos sync-jds');

    // ─── Step 4: ecosystem + start ────────────────────────────────────────────
    console.log('\n  ─────────────────────────────────────\n');
    if (noStart) {
      console.log('  Step 4: Skipping daemon start (--no-start).\n');
    } else {
      console.log('  Step 4: Generating ecosystem config and starting the daemon...\n');
      const firstOrg = teams[0]?.org ?? '';
      const ecoEnv = { ...process.env, CTX_INSTANCE_ID: instanceId, CTX_ORG: firstOrg };
      const eco = spawnSync(process.execPath, [join(projectRoot, 'dist', 'cli.js'), 'ecosystem', '--instance', instanceId], {
        cwd: projectRoot, stdio: 'inherit', env: ecoEnv,
      });
      if (eco.status !== 0) {
        console.error('  Failed to generate ecosystem config. Run manually: officeos ecosystem');
      } else {
        const pm2 = spawnSync('pm2', ['start', 'ecosystem.config.js'], { cwd: projectRoot, stdio: 'inherit' });
        if (pm2.status === 0) {
          spawnSync('pm2', ['save'], { cwd: projectRoot, stdio: 'inherit' });
          console.log('\n  Daemon started via PM2.');
        } else {
          runCli(projectRoot, ['start', '--instance', instanceId], 'officeos start');
        }
      }
    }

    iface.close();

    // ─── Done ─────────────────────────────────────────────────────────────────
    console.log('\n  ─────────────────────────────────────\n');
    console.log('  Onboarding complete!\n');
    for (const t of teams) {
      const roster = [t.orch, ...t.specialists].join(', ');
      console.log(`  Team ${t.org}: ${roster}`);
    }
    console.log(`\n  State: ${ctxRoot}\n`);
    console.log('  Next steps:');
    console.log('    - Verify everything:  officeos doctor');
    console.log('    - Check agent status: officeos status');
    console.log('    - Open the dashboard: officeos dashboard');
    console.log('    - DM your orchestrator in its Slack channel!\n');
  });
