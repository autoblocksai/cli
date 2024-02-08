#!/bin/env node
import process from 'process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { handlers } from './handlers/index.js';

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
      const [command, ...args] = argv._.slice(1).map(String);

      handlers.testing.exec({
        command,
        commandArgs: args,
        runMessage: argv.message,
        port: argv.port,
        interactive: argv.interactive,
      });
    },
  )
  .parse();
