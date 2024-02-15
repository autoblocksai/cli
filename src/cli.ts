#!/bin/env node
import process from 'process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { handlers } from './handlers/index.js';

const errorMessage = `No command found. Provide a command following '--'. For example:

npx autoblocks testing exec -- echo "Hello, world!
`;

yargs(hideBin(process.argv))
  .command(
    'testing exec',
    'Execute a command that runs Autoblocks tests',
    (yargs) => {
      return yargs
        .option('api-key', {
          describe: 'Autoblocks API key',
          type: 'string',
          default: process.env.AUTOBLOCKS_API_KEY,
          demandOption: true,
        })
        .option('message', {
          alias: 'm',
          describe: 'Description for this run',
          type: 'string',
        })
        .option('interactive', {
          alias: 'i',
          describe: 'Run tests interactively',
          type: 'boolean',
          default: false,
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
        interactive: argv.interactive,
        port: argv.port,
        exit1OnEvaluationFailure: argv['exit-1-on-evaluation-failure'],
      });
    },
  )
  // Populates `argv['--']` with the unparsed arguments after --
  .parserConfiguration({
    'populate--': true,
  })
  .parse();
