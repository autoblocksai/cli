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
        .option('message', {
          alias: 'm',
          describe: 'Description for this run',
          type: 'string',
        })
        .option('port', {
          alias: 'p',
          describe: 'Local test server port number',
          type: 'number',
          default: 5555,
        })
        .option('interactive', {
          alias: 'i',
          describe: 'Run command interactively',
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
        runMessage: argv.message,
        port: argv.port,
        interactive: argv.interactive,
      });
    },
  )
  // Populates `argv['--']` with the unparsed arguments after --
  .parserConfiguration({
    'populate--': true,
  })
  .parse();
