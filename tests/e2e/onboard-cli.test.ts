/**
 * Black-box CLI E2E for `officeos onboard`.
 *
 * Spawns the real `dist/cli.js onboard` as a child process, drives its readline
 * prompts over stdin, and asserts on the files it produces — the genuine
 * end-to-end path a user walks, minus network and pm2.
 *
 * Slack is mocked by default via OFFICEOS_CHANNEL_ADAPTER=mock. A live variant
 * (OFFICEOS_E2E_LIVE_SLACK=1 + real tokens) hits api.slack.com instead.
 *
 * Isolation: a temp framework root with dist/ and templates/ symlinked in.
 * Node resolves node_modules from the symlink's realpath, so the symlinked
 * cli.js still finds the repo's real dependencies. orgs/ are written into the
 * temp root (real dir), never the repo.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import {
  mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync, readFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = join(__dirname, '..', '..');
const realCli = join(repoRoot, 'dist', 'cli.js');
const distPresent = existsSync(realCli);

interface WizardResult { code: number | null; stdout: string; stderr: string; }

/**
 * Drive an interactive CLI by dripping answers. Sub-commands use blocking
 * spawnSync (freezing the event loop), so feeding all answers + closing stdin
 * up front races readline to EOF. Instead: send the next answer only when the
 * wizard's stdout has gone idle (it's sitting at a prompt). Close stdin after
 * the last answer's idle so a hung prompt can't deadlock the test.
 */
function runWizard(tempRoot: string, tempHome: string, answers: string[], extraEnv: Record<string, string> = {}): Promise<WizardResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tempHome,
      CTX_FRAMEWORK_ROOT: tempRoot,
      CTX_PROJECT_ROOT: tempRoot,
      OFFICEOS_ONBOARD_SKIP_INSTALL: '1',
      OFFICEOS_ONBOARD_NO_START: '1',
      OFFICEOS_ONBOARD_SKIP_ENABLE: '1',
      OFFICEOS_CHANNEL_ADAPTER: 'mock',
      ...extraEnv,
    };
    const child = spawn(process.execPath, [join(tempRoot, 'dist', 'cli.js'), 'onboard', '--instance', 'e2e'], {
      cwd: tempRoot, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const queue = [...answers];
    const IDLE_MS = 250;
    let timer: NodeJS.Timeout | null = null;

    const onIdle = () => {
      if (queue.length > 0) {
        child.stdin.write(queue.shift()! + '\n');
        arm();
      } else {
        child.stdin.end();
      }
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onIdle, IDLE_MS);
    };

    child.stdout.on('data', d => { stdout += d.toString(); arm(); });
    child.stderr.on('data', d => { stderr += d.toString(); arm(); });
    child.on('error', reject);
    child.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
    arm(); // kick the first drip once the banner settles
  });
}

describe.skipIf(!distPresent)('officeos onboard — black-box CLI E2E', () => {
  let tempRoot: string;
  let tempHome: string;

  beforeAll(() => {
    if (!distPresent) {
      // eslint-disable-next-line no-console
      console.warn('dist/cli.js missing — run `npm run build` before the E2E suite. Skipping.');
    }
  });

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'onboard-e2e-'));
    tempHome = mkdtempSync(join(tmpdir(), 'onboard-home-'));
    symlinkSync(join(repoRoot, 'dist'), join(tempRoot, 'dist'), 'dir');
    symlinkSync(join(repoRoot, 'templates'), join(tempRoot, 'templates'), 'dir');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('builds a one-team office: Slack .env, swapped hooks, shared JD, registry', async () => {
    const answers = [
      'docs',                            // team / org name
      'docs-orch',                       // orchestrator name
      'xoxb-test',                       // bot token
      'xapp-test',                       // app token
      'U01OWNER23',                      // owner user id (!= mock bot id)
      'C01DOCS234',                      // channel id
      'n',                               // restrict domain?
      'y',                               // add a specialist?
      'doc-writer',                      // specialist name
      'Documentation Specialist',        // title
      'Writes and edits internal docs',  // description
      'y',                               // share across teams?
      'n',                               // add another specialist?
      'n',                               // add another team?
    ];
    const { code, stdout } = await runWizard(tempRoot, tempHome, answers);
    expect(code, stdout).toBe(0);
    expect(stdout).toMatch(/Onboarding complete/);

    const orchDir = join(tempRoot, 'orgs', 'docs', 'agents', 'docs-orch');
    const env = readFileSync(join(orchDir, '.env'), 'utf-8');
    expect(env).toContain('SLACK_BOT_TOKEN=xoxb-test');
    expect(env).toContain('SLACK_USER_ID=U01OWNER23');
    expect(env).toContain('SLACK_CHANNEL_ID=C01DOCS234');

    const settings = readFileSync(join(orchDir, '.claude', 'settings.json'), 'utf-8');
    expect(settings).toContain('hook-permission-slack.js');
    expect(settings).not.toContain('telegram');

    const specCfg = JSON.parse(readFileSync(join(tempRoot, 'orgs', 'docs', 'agents', 'doc-writer', 'config.json'), 'utf-8'));
    expect(specCfg.jd.title).toBe('Documentation Specialist');
    expect(specCfg.jd.shared).toBe(true);

    const registry = readFileSync(join(orchDir, 'jds-registry.md'), 'utf-8');
    expect(registry).toContain('doc-writer');
  }, 60000);

  it('shared agent crosses orgs; team-internal does not', async () => {
    const answers = [
      // team 1: docs with a SHARED codebase agent + a PRIVATE doc-writer
      'docs', 'docs-orch',
      'xoxb-test', 'xapp-test', 'U01OWNER23', 'C01DOCS234', 'n',
      'y', 'codebase', 'Codebase Expert', 'Explains internal code', 'y',     // shared
      'y', 'doc-writer', 'Doc Specialist', 'Writes docs', 'n',              // private
      'n',                                                                   // no more specialists
      'y',                                                                   // add another team
      // team 2: marketing, reuse slack app, own channel
      'marketing', 'marketing-orch',
      'y',                 // reuse bot/app
      '',                  // owner id — accept default (reused)
      'C02MKTG567',        // new channel
      'n',                 // restrict domain?
      'n',                 // add a specialist?
      'n',                 // add another team?
    ];
    const { code, stdout } = await runWizard(tempRoot, tempHome, answers);
    expect(code, stdout).toBe(0);

    const mktgRegistry = readFileSync(
      join(tempRoot, 'orgs', 'marketing', 'agents', 'marketing-orch', 'jds-registry.md'), 'utf-8');
    // shared codebase agent visible to marketing; private doc-writer is not
    expect(mktgRegistry).toContain('codebase');
    expect(mktgRegistry).not.toContain('doc-writer');
  }, 60000);

  it('blocks a duplicate agent name and re-prompts', async () => {
    const answers = [
      'docs', 'docs-orch',
      'xoxb-test', 'xapp-test', 'U01OWNER23', 'C01DOCS234', 'n',
      'y',
      'docs-orch',     // duplicate of the orchestrator — must be rejected
      'doc-writer',    // valid retry
      'Doc Specialist', 'Writes docs', 'n',
      'n',             // no more specialists
      'n',             // no more teams
    ];
    const { code, stdout } = await runWizard(tempRoot, tempHome, answers);
    expect(code, stdout).toBe(0);
    expect(stdout).toMatch(/already taken/i);
    expect(existsSync(join(tempRoot, 'orgs', 'docs', 'agents', 'doc-writer'))).toBe(true);
  }, 60000);
});

// Live Slack — opt-in. Requires real bot+app tokens; hits api.slack.com.
describe.runIf(process.env.OFFICEOS_E2E_LIVE_SLACK === '1' && distPresent)('officeos onboard — LIVE Slack', () => {
  let tempRoot: string;
  let tempHome: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'onboard-live-'));
    tempHome = mkdtempSync(join(tmpdir(), 'onboard-live-home-'));
    symlinkSync(join(repoRoot, 'dist'), join(tempRoot, 'dist'), 'dir');
    symlinkSync(join(repoRoot, 'templates'), join(tempRoot, 'templates'), 'dir');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('validates a real bot token against api.slack.com', async () => {
    const botToken = process.env.SLACK_BOT_TOKEN!;
    const appToken = process.env.SLACK_APP_TOKEN || 'xapp-unused';
    const userId = process.env.SLACK_USER_ID || 'U00000000';
    const channelId = process.env.SLACK_CHANNEL_ID || 'C00000000';
    const answers = ['docs', 'docs-orch', botToken, appToken, userId, channelId, 'n', 'n', 'n'];
    // No OFFICEOS_CHANNEL_ADAPTER override → real Slack adapter.
    const { code, stdout } = await runWizard(tempRoot, tempHome, answers, { OFFICEOS_CHANNEL_ADAPTER: '' });
    expect(code, stdout).toBe(0);
    expect(stdout).toMatch(/Validated bot token/);
  }, 60000);
});
