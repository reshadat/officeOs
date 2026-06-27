import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { patchJD, wireSlackHooks, writeSlackEnv } from '../../../src/cli/onboard.js';

describe('onboard helpers', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onboard-helpers-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('patchJD', () => {
    it('fills title/description and preserves empty arrays, no shared by default', () => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ agent_name: 'a', jd: { title: '', responsibilities: ['keep'] } }));
      patchJD(dir, 'Doc Specialist', 'Writes docs', false);
      const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
      expect(cfg.jd.title).toBe('Doc Specialist');
      expect(cfg.jd.description).toBe('Writes docs');
      expect(cfg.jd.responsibilities).toEqual(['keep']);
      expect(cfg.jd.shared).toBeUndefined();
    });

    it('sets shared:true when requested', () => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ agent_name: 'a', jd: {} }));
      patchJD(dir, 'Codebase', 'Reads code', true);
      const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
      expect(cfg.jd.shared).toBe(true);
    });

    it('is a no-op when config.json is absent', () => {
      expect(() => patchJD(dir, 't', 'd', false)).not.toThrow();
    });
  });

  describe('writeSlackEnv', () => {
    it('writes all keys and chmods 600', () => {
      writeSlackEnv(dir, { botToken: 'xoxb-1', appToken: 'xapp-1', userId: 'U1', channelId: 'C1' });
      const env = readFileSync(join(dir, '.env'), 'utf-8');
      expect(env).toContain('SLACK_BOT_TOKEN=xoxb-1');
      expect(env).toContain('SLACK_APP_TOKEN=xapp-1');
      expect(env).toContain('SLACK_USER_ID=U1');
      expect(env).toContain('SLACK_CHANNEL_ID=C1');
      expect(env).not.toContain('SLACK_ALLOWED_DOMAINS');
      // 0o600 — owner rw only (skip strict check on Windows)
      if (process.platform !== 'win32') {
        expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
      }
    });

    it('includes allowed domains when present', () => {
      writeSlackEnv(dir, { botToken: 'b', appToken: 'a', userId: 'U', channelId: 'C', allowedDomains: 'acme.com' });
      expect(readFileSync(join(dir, '.env'), 'utf-8')).toContain('SLACK_ALLOWED_DOMAINS=acme.com');
    });
  });

  describe('wireSlackHooks', () => {
    // The orchestrator template ships Telegram hooks. The wizard swaps the whole
    // hooks block to the Slack set, preserving the permissions block.
    const telegramSettings = {
      permissions: { allow: ['Bash', 'Read'], defaultMode: 'bypassPermissions' },
      hooks: {
        PermissionRequest: [
          { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: 'cortextos bus hook-planmode-telegram', timeout: 1860 }] },
          { hooks: [{ type: 'command', command: 'cortextos bus hook-permission-telegram', timeout: 1860 }] },
        ],
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'cortextos bus hook-loop-detector', timeout: 5 }] },
          { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'cortextos bus hook-ask-telegram', timeout: 10 }] },
        ],
      },
    };

    it('swaps Telegram hooks for Slack and preserves permissions', () => {
      const claudeDir = join(dir, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(telegramSettings));

      const ok = wireSlackHooks(dir, '/proj');
      expect(ok).toBe(true);

      const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
      const flat = JSON.stringify(out.hooks);
      // permissions untouched
      expect(out.permissions).toEqual(telegramSettings.permissions);
      // no telegram left anywhere
      expect(flat).not.toContain('telegram');
      // slack hooks present with absolute dist paths
      expect(flat).toContain('/proj/dist/hooks/hook-permission-slack.js');
      expect(flat).toContain('/proj/dist/hooks/hook-planmode-slack.js');
      expect(flat).toContain('/proj/dist/hooks/hook-ask-slack.js');
      expect(flat).toContain('/proj/dist/hooks/hook-compact-slack.js');
      expect(flat).toContain('/proj/dist/hooks/hook-crash-alert-slack.js');
      // loop-detector + crash-alert (channel-agnostic) survive
      expect(flat).toContain('cortextos bus hook-loop-detector');
      expect(flat).toContain('cortextos crash-alert');
    });

    it('returns false when settings.json is missing', () => {
      expect(wireSlackHooks(dir, '/proj')).toBe(false);
    });
  });
});
