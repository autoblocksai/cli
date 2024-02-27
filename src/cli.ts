#!/bin/env node
import process from 'process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import packageJson from '../package.json';
import { renderOutdatedVersionComponent } from './components/outdated-version';
import { handlers } from './handlers/index.js';

const packageName = packageJson.name;
const packageVersion = packageJson.version;

async function getLatestVersion(): Promise<string> {
  const response = await fetch(
    `https://registry.npmjs.org/${packageName}/latest`,
  );
  const data = await response.json();
  return data.version;
}

async function latestVersionMiddleware(): Promise<void> {
  try {
    if (process.env.CI) {
      return;
    }

    const latestVersion = await getLatestVersion();
    if (latestVersion !== packageVersion) {
      renderOutdatedVersionComponent({
        currentVersion: packageVersion,
        latestVersion,
      });
    }
  } catch {
    // Ignore
  }
}

yargs(hideBin(process.argv))
  .command(
    'testing exec',
    'Execute a command that runs Autoblocks tests',
    (yargs) => {
      return yargs
        .option('api-key', {
          describe:
            'Autoblocks API key. Can be set via the AUTOBLOCKS_API_KEY environment variable.',
          type: 'string',
          default: process.env.AUTOBLOCKS_API_KEY,
          demandOption: true,
        })
        .option('message', {
          alias: 'm',
          describe: 'Description for this test run',
          type: 'string',
        })
        .option('port', {
          alias: 'p',
          describe: 'Local test server port number',
          type: 'number',
          default: 5555,
        })
        .option('exit-1-on-evaluation-failure', {
          describe: 'Exit with code 1 if any evaluation fails.',
          type: 'boolean',
          default: false,
        })
        .help();
    },
    (argv) => {
      const errorMessage = `No command found. Provide a command following '--'. For example:

npx autoblocks testing exec -- echo "Hello, world!
`;

      const unparsed = argv['--'];
      if (!Array.isArray(unparsed)) {
        throw new Error(errorMessage);
      }

      const [command, ...commandArgs] = unparsed.map(String);

      if (!command) {
        throw new Error(errorMessage);
      }

      handlers.testing.exec({
        command,
        commandArgs,
        apiKey: argv['api-key'],
        runMessage: argv.message,
        port: argv.port,
        exit1OnEvaluationFailure: argv['exit-1-on-evaluation-failure'],
      });
    },
  )
  // Populates `argv['--']` with the unparsed arguments after --
  // https://github.com/yargs/yargs-parser?tab=readme-ov-file#populate---
  .parserConfiguration({
    'populate--': true,
  })
  // Makes it so that the script name is "autoblocks" and not
  // the name of the CLI entrypoint file (cli.mjs)
  // https://yargs.js.org/docs/#api-reference-scriptname0
  .scriptName('autoblocks')
  .middleware(latestVersionMiddleware)
  .parse();
