#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

// The location of the built CLI entrypoint relative to this file's location
const CLI_PATH = '../dist/cli.js';

function runCLI() {
  return spawn(
    process.execPath,
    [
      '--no-warnings',
      '--experimental-vm-modules',
      ...process.execArgv,
      path.join(__dirname, CLI_PATH),
      // Slice off the first two arguments, which are the path to Node and the path to this file
      ...process.argv.slice(2),
    ],
    {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    },
  )
    .on('exit', (code) =>
      process.exit(code === undefined || code === null ? 0 : code),
    )
    .on('message', (message) => {
      if (process.send) {
        process.send(message);
      }
    })
    .on('disconnect', () => {
      if (process.disconnect) {
        process.disconnect();
      }
    });
}

let cliProcess;

if (module === require.main) {
  cliProcess = runCLI();
  process.on('SIGINT', () => {
    cliProcess?.kill();
  });
  process.on('SIGTERM', () => {
    cliProcess?.kill();
  });
}
