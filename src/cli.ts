// Operator CLI entry: `docker compose exec app node dist/cli.js <command>` (see src/admin/cli.ts).
// Output goes to stdout, errors to stderr; nothing here logs secrets.
import { HELP, runCli } from './admin/cli.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';

const argv = process.argv.slice(2);
const io = { out: (l: string) => process.stdout.write(`${l}\n`), err: (l: string) => process.stderr.write(`${l}\n`) };

let code = 1;
if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
  io.out(HELP); // no config or DB needed
  code = argv.length === 0 ? 1 : 0;
} else {
  try {
    const config = loadConfig();
    const db = openDb(config.paths.db);
    try {
      code = await runCli(argv, { config, db, io });
    } finally {
      db.close();
    }
  } catch (err) {
    io.err(`error: ${(err as Error).message}`);
    code = 1;
  }
}
process.exitCode = code;
