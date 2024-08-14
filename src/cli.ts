#!/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import packageJson from '../package.json';
import { renderOutdatedVersionComponent } from './components/outdated-version';
import { handlers } from './handlers/index.js';
import { AutoblocksTracer, flush } from '@autoblocks/client';
import {
  AUTOBLOCKS_WEBAPP_BASE_URL,
  AUTOBLOCKS_API_KEY_NAME,
  AUTOBLOCKS_SLACK_WEBHOOK_URL_NAME,
} from './util/constants';
import fs from 'fs';

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

/**
 * Read variable from process.env or from a .env file in the current working directory.
 */
const variableFromEnv = (variableName: string): string | undefined => {
  const value = process.env[variableName];
  if (value) {
    return value;
  }

  try {
    const envFile = fs.readFileSync('.env', 'utf-8');
    const match = envFile.match(new RegExp(`^${variableName}=(.*)$`, 'm'));
    if (match) {
      return match[1];
    }
  } catch {
    // Ignore
  }

  return undefined;
};

// The newline at the top of these messages is intentional;
// it gives separation between the error message shown by
// yargs and this one.
const apiKeyMissingErrorMessage = `
Autoblocks API key is required.
Provide it via the ${AUTOBLOCKS_API_KEY_NAME} environment variable, within a .env file, or the --api-key option.

You can get your API key from ${AUTOBLOCKS_WEBAPP_BASE_URL}/settings/api-keys`;

const makeTestingCommandNotFoundErrorMessage = (command: string) => `
No command found. Provide a command following '--'. For example:

npx autoblocks testing ${command} -- echo "Hello, world!
`;

const parseCommandFromArgv = (args: {
  command: string;
  argv: yargs.Arguments;
}): { command: string; commandArgs: string[] } => {
  const unparsed = args.argv['--'];
  if (!Array.isArray(unparsed)) {
    throw new Error(makeTestingCommandNotFoundErrorMessage(args.command));
  }

  const [command, ...commandArgs] = unparsed.map(String);

  if (!command) {
    throw new Error(makeTestingCommandNotFoundErrorMessage(args.command));
  }

  return { command, commandArgs };
};

const apiKeyOptions = {
  describe: `Autoblocks API key. Can be set via the ${AUTOBLOCKS_API_KEY_NAME} environment variable`,
  type: 'string',
  default: variableFromEnv(AUTOBLOCKS_API_KEY_NAME),
  demandOption: apiKeyMissingErrorMessage,
} as const;

const portOptions = {
  alias: 'p',
  describe: 'Local CLI server port number',
  type: 'number',
  default: 5555,
} as const;

const parser = yargs(hideBin(process.argv))
  .command('testing', 'Autoblocks Testing', (yargs) => {
    return yargs
      .command(
        'exec',
        'Execute a command that runs your Autoblocks test suites',
        (yargs) => {
          return yargs
            .option('api-key', apiKeyOptions)
            .option('message', {
              alias: 'm',
              describe: 'Description for this test run',
              type: 'string',
            })
            .option('test-suites', {
              alias: 'ts',
              describe:
                'List of test suite IDs to run. A substring match will be performed on each ID.',
              type: 'array',
              default: [],
            })
            .option('port', portOptions)
            .option('exit-1-on-evaluation-failure', {
              describe: 'Exit with code 1 if any evaluation fails',
              type: 'boolean',
              default: false,
            })
            .option('slack-webhook-url', {
              describe: `Slack webhook URL where results are posted. Can be set via the ${AUTOBLOCKS_SLACK_WEBHOOK_URL_NAME} environment variable`,
              type: 'string',
              default: variableFromEnv(AUTOBLOCKS_SLACK_WEBHOOK_URL_NAME),
            })
            .option('shared', {
              describe:
                'Output a shareable url for this test run. Ignored when running on CI.',
              type: 'boolean',
              default: false,
            })
            .help();
        },
        (argv) => {
          const { command, commandArgs } = parseCommandFromArgv({
            command: 'exec',
            argv,
          });

          handlers.testing.exec({
            command,
            commandArgs,
            apiKey: argv['api-key'],
            // Convert test-suites to strings to avoid issues with yargs
            testSuites: argv['test-suites'].map((testSuite) => `${testSuite}`),
            runMessage: argv.message,
            port: argv.port,
            exit1OnEvaluationFailure: argv['exit-1-on-evaluation-failure'],
            slackWebhookUrl: argv['slack-webhook-url'],
            includeShareUrl: Boolean(argv['shared']),
          });
        },
      )
      .command(
        'align',
        'Align an Autoblocks test suite with human-in-the-loop feedback',
        (yargs) => {
          return yargs
            .option('api-key', apiKeyOptions)
            .option('test-suite-id', {
              describe: 'ID of the test suite to align',
              type: 'string',
              demandOption: true,
            })
            .option('port', portOptions)
            .help();
        },
        (argv) => {
          const { command, commandArgs } = parseCommandFromArgv({
            command: 'align',
            argv,
          });

          handlers.testing.align({
            command,
            commandArgs,
            testExternalId: argv['test-suite-id'],
            apiKey: argv['api-key'],
            port: argv.port,
          });
        },
      )
      .command(
        'make-ci-context',
        'Make the context for a CI test run and set as GitHub environment variables. Used when running Autoblocks tests in CI, without using exec.',
        (yargs) => {
          return yargs
            .option('api-key', apiKeyOptions)
            .option('slack-webhook-url', {
              describe: `Slack webhook URL where results are posted. Can be set via the ${AUTOBLOCKS_SLACK_WEBHOOK_URL_NAME} environment variable`,
              type: 'string',
              default: variableFromEnv(AUTOBLOCKS_SLACK_WEBHOOK_URL_NAME),
            })
            .help();
        },
        (argv) => {
          handlers.testing.makeCIContext({
            apiKey: argv['api-key'],
            slackWebhookUrl: argv['slack-webhook-url'],
          });
        },
      );
  })
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
      tracer.sendEvent('cli.error', {
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

    await flush();
    process.exit(1);
  }
})();
