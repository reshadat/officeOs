import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function writeFakeAgent(baseDir: string, org: string, name: string, jd: object) {
  const dir = join(baseDir, 'orgs', org, 'agents', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ name, jd }));
  return dir;
}

describe('sync-jds', () => {
  let tmp: string;

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sync-jds-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('writes registry to orchestrator agent dir', async () => {
    writeFakeAgent(tmp, 'myorg', 'orchestrator', {
      title: 'Officer', description: 'Routes queries', responsibilities: ['Route queries'],
      provides: ['routing'], needs: [], keywords: ['route'],
    });
    writeFakeAgent(tmp, 'myorg', 'doc-agent', {
      title: 'Doc Specialist', description: 'Finds docs', responsibilities: ['Find documentation'],
      provides: ['documentation search'], needs: ['codebase context'], keywords: ['docs'],
    });
    const { syncJDs } = await import('../../../src/cli/sync-jds.js');
    syncJDs(tmp);
    const registryPath = join(tmp, 'orgs', 'myorg', 'agents', 'orchestrator', 'jds-registry.md');
    expect(existsSync(registryPath)).toBe(true);
    const content = readFileSync(registryPath, 'utf-8');
    expect(content).toContain('doc-agent');
    expect(content).toContain('Doc Specialist');
    expect(content).toContain('# Agent Directory');
  });

  it('writes collaborators.md when needs match provides', async () => {
    writeFakeAgent(tmp, 'myorg', 'orchestrator', {
      title: 'Officer', description: 'Routes queries', responsibilities: [],
      provides: ['routing'], needs: [], keywords: [],
    });
    writeFakeAgent(tmp, 'myorg', 'doc-agent', {
      title: 'Doc Specialist', description: 'Finds docs', responsibilities: [],
      provides: ['documentation search'], needs: ['routing'], keywords: [],
    });
    const { syncJDs } = await import('../../../src/cli/sync-jds.js');
    syncJDs(tmp);
    const collabPath = join(tmp, 'orgs', 'myorg', 'agents', 'doc-agent', 'memory', 'collaborators.md');
    expect(existsSync(collabPath)).toBe(true);
    const content = readFileSync(collabPath, 'utf-8');
    expect(content).toContain('orchestrator');
  });

  it('handles agents with no jd block gracefully', async () => {
    const dir = join(tmp, 'orgs', 'myorg', 'agents', 'no-jd-agent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ name: 'no-jd-agent' }));
    const { syncJDs } = await import('../../../src/cli/sync-jds.js');
    expect(() => syncJDs(tmp)).not.toThrow();
  });

  it('skips agents with empty jd title', async () => {
    writeFakeAgent(tmp, 'myorg', 'draft-agent', {
      title: '', description: '', responsibilities: [], provides: [], needs: [], keywords: [],
    });
    const { syncJDs } = await import('../../../src/cli/sync-jds.js');
    const result = syncJDs(tmp);
    expect(result.registry).toBe(0);
  });

  it('registry includes out_of_scope when present', async () => {
    writeFakeAgent(tmp, 'myorg', 'orchestrator', {
      title: 'Officer', description: 'Routes', responsibilities: ['Route'],
      provides: ['routing'], needs: [], keywords: [], out_of_scope: ['deploy', 'code review'],
    });
    const { syncJDs } = await import('../../../src/cli/sync-jds.js');
    syncJDs(tmp);
    const registryPath = join(tmp, 'orgs', 'myorg', 'agents', 'orchestrator', 'jds-registry.md');
    const content = readFileSync(registryPath, 'utf-8');
    expect(content).toContain('deploy');
  });
});
