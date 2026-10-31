import { parseArgs } from 'node:util';
import { loadConfig } from '../core/config.js';
import { ensureAgentDirs } from '../core/vault.js';
import doctor from './doctor.js';
import ingestCommand from './ingest.js';
import runCommand from './run.js';

const USAGE = `scope — personal local-agent CLI

  scope doctor              check the environment this depends on
  scope init                create the agent's subdirectories in the vault
  scope run <task>          run a task by id (vault scope/tasks/<id>.md) or path
  scope ingest <source> <file>
                            ingest notes into the vault from a payload file

  --verbose, -v             show every gate result as it runs
  --vault <path>            override the vault for this invocation
  --dry-run                 show what ingest would write, change nothing
`;

export default async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      verbose: { type: 'boolean', short: 'v', default: false },
      'dry-run': { type: 'boolean', default: false },
      vault: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  const config = await loadConfig();
  if (values.vault) config.vault = values.vault;

  switch (command) {
    case 'doctor':
      process.exitCode = await doctor(config);
      return;
    case 'init':
      await ensureAgentDirs(config);
      console.log(`ready: ${config.vault}/${config.agentPrefix}/`);
      return;
    case 'ingest': {
      if (!rest[0]) throw new Error(`ingest needs a source, e.g. "scope ingest granola notes.json"`);
      process.exitCode = await ingestCommand(config, rest[0], rest[1], { dryRun: values['dry-run'] });
      return;
    }
    case 'run': {
      if (!rest[0]) throw new Error('run needs a task id or path');
      process.exitCode = await runCommand(config, rest[0], { verbose: values.verbose });
      return;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}
