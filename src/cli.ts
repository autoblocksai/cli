#!/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import packageJson from '../package.json';
import { renderOutdatedVersionComponent } from './components/outdated-version';
import { handlers } from './handlers/index.js';
import { AutoblocksTracer } from '@autoblocks/client';
import { AUTOBLOCKS_WEBAPP_BASE_URL } from './util/constants';

const packageName = packageJson.name;
const packageVersion = packageJson.version;

/**
 * Get the latest version of this package from the npm registry
 * so we can show the user their CLI is out of date.
 */
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

// The newline at the top of this message is intentional;
// it gives separation between the error message shown by
// yargs and this one.
const apiKeyMissingErrorMessage = `
Autoblocks API key is required.
Provide it via the AUTOBLOCKS_API_KEY environment variable or the --api-key option.

You can get your API key from ${AUTOBLOCKS_WEBAPP_BASE_URL}/settings/api-keys`;

const parser = yargs(hideBin(process.argv))
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
        .option('slack-webhook-url', {
          describe:
            'Slack webhook URL where results are posted. Can be set via the AUTOBLOCKS_SLACK_WEBHOOK_URL environment variable.',
          type: 'string',
          default: process.env.AUTOBLOCKS_SLACK_WEBHOOK_URL,
        })
        .demandOption('api-key', apiKeyMissingErrorMessage)
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
        slackWebhookUrl: argv['slack-webhook-url'],
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
  // Don't allow unknown commands / options
  .strict()
  // We're handling errors ourselves below so that we can send them to Autoblocks
  .fail(false);

(async () => {
  try {
    // Parse and run the user's CLI command
    await parser.parse();
  } catch (err: unknown) {
    const { errorName, errorMessage } =
      err instanceof Error
        ? {
            errorName: err.name,
            errorMessage: err.message,
          }
        : {
            errorName: 'UnknownError',
            errorMessage: `${err}`,
          };

    // Log the CLI's help message followed by the error message
    // TODO: render this with an ink component
    // eslint-disable-next-line no-console
    console.info(`${await parser.getHelp()}\n\n${errorMessage}`);

    try {
      // Initialize the tracer within the try-catch, since it's possible
      // for tsup to have failed to bundle the ingestion key as a
      // compile-time variable. This can happen if someone accidentally
      // adds "import process from 'process'" to the top of this file,
      // which ends up compiling to "import process2 from 'process'" and
      // tsup only does replacement if it references `process` directly.
      const tracer = new AutoblocksTracer({
        ingestionKey: process.env.TSUP_PUBLIC_AUTOBLOCKS_INGESTION_KEY,
        // Use a small timeout, since sending the event blocks the process
        // from exiting.
        timeout: { seconds: 1 },
      });

      // Send error to Autoblocks
      await tracer.sendEvent('cli.error', {
        properties: {
          version: packageVersion,
          error: {
            name: errorName,
            // Don't include the full stacktrace, just the message.
            // Full stacktraces can contains sensitive information.
            message: errorMessage,
          },
        },
      });
    } catch {
      // Ignore
    }

    process.exit(1);
  }
})();
