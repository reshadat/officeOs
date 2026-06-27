import { Command } from 'commander';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { initCommand } from './init.js';
import { addAgentCommand } from './add-agent.js';
import { startCommand } from './start.js';
import { stopCommand } from './stop.js';
import { restartCommand } from './restart.js';
import { statusCommand } from './status.js';
import { doctorCommand } from './doctor.js';
import { busCommand } from './bus.js';
import { listAgentsCommand } from './list-agents.js';
import { notifyAgentCommand } from './notify-agent.js';
import { listSkillsCommand } from './list-skills.js';
import { installCommand } from './install.js';
import { enableAgentCommand, disableAgentCommand } from './enable-agent.js';
import { ecosystemCommand } from './ecosystem.js';
import { uninstallCommand } from './uninstall.js';
import { dashboardCommand } from './dashboard.js';
import { tunnelCommand } from './tunnel.js';
import { getConfigCommand } from './get-config.js';
import { goalsCommand } from './goals.js';
import { setupCommand } from './setup.js';
import { onboardCommand } from './onboard.js';
import { spawnWorkerCommand, terminateWorkerCommand, listWorkersCommand, injectWorkerCommand } from './workers.js';
import { importAgentCommand } from './import-agent.js';
import { updateCommand } from './update.js';
import { syncJDs } from './sync-jds.js';
import { listJDs } from './list-jds.js';

const program = new Command();

program
  .name('officeos')
  .description('Persistent AI agent teams on your own infra, run from Slack')
  .version('0.1.1');

program.addCommand(initCommand);
program.addCommand(installCommand);
program.addCommand(addAgentCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(restartCommand);
program.addCommand(statusCommand);
program.addCommand(doctorCommand);
program.addCommand(busCommand);
program.addCommand(listAgentsCommand);
program.addCommand(notifyAgentCommand);
program.addCommand(listSkillsCommand);
program.addCommand(enableAgentCommand);
program.addCommand(disableAgentCommand);
program.addCommand(ecosystemCommand);
program.addCommand(uninstallCommand);
program.addCommand(dashboardCommand);
program.addCommand(tunnelCommand);
program.addCommand(getConfigCommand);
program.addCommand(goalsCommand);
program.addCommand(setupCommand);
program.addCommand(onboardCommand);
program.addCommand(spawnWorkerCommand);
program.addCommand(terminateWorkerCommand);
program.addCommand(listWorkersCommand);
program.addCommand(injectWorkerCommand);
program.addCommand(importAgentCommand);
program.addCommand(updateCommand);

program
  .command('sync-jds')
  .description('Sync agent JD blocks to jds-registry.md and collaborator files')
  .option('--ctx-root <path>', 'Override CTX_ROOT')
  .action((opts) => { syncJDs(opts.ctxRoot); });

program
  .command('list-jds')
  .description('List all agents with their job descriptions')
  .option('--ctx-root <path>', 'Override CTX_ROOT')
  .action((opts) => { listJDs(opts.ctxRoot); });

// crash-alert: SessionEnd hook — cross-platform replacement for crash-alert.sh
const crashAlertCommand = new Command('crash-alert')
  .description('SessionEnd hook: send crash/restart notification via Telegram (cross-platform)')
  .action(() => {
    const hookPath = join(__dirname, 'hooks/hook-crash-alert.js');
    const result = spawnSync(process.execPath, [hookPath], { stdio: 'inherit' });
    process.exit(result.status ?? 0);
  });
program.addCommand(crashAlertCommand);

program.parse();
