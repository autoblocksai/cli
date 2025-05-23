import { exec as execCommand } from '@actions/exec';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server/dist/types';
import { renderTestProgress } from './components/progress';
import { EventName, emitter } from './util/emitter';
import { findAvailablePort } from './util/net';
import { RunManager } from './util/run-manager';
import { createHonoApp } from './util/hono-app';
import { SDKEnvironmentVariable, makeSDKEnvVars } from '../../../util/sdk-env';

/**
 * Exec command while local server is running
 */
export async function exec(args: {
  command: string;
  commandArgs: string[];
  apiKey: string;
  testSuites: string[];
  runMessage: string | undefined;
  port: number;
  exit1OnEvaluationFailure: boolean;
  slackWebhookUrl: string | undefined;
  includeShareUrl: boolean;
}) {
  const runManager = new RunManager({
    apiKey: args.apiKey,
    runMessage: args.runMessage,
    includeShareUrl: args.includeShareUrl,
  });

  const ciContextResult = await runManager.setupCIContext();

  let listenersCreated = false;
  renderTestProgress({
    onListenersCreated: () => (listenersCreated = true),
    ciBranchId: runManager.getCIBranchId(),
    ciBuildId: runManager.getCIBuildId(),
  });

  // Wait for listeners to be created before starting the server
  while (!listenersCreated) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  if (ciContextResult) {
    emitter.emit(EventName.CONSOLE_LOG, {
      ctx: 'cli',
      level: 'debug',
      message: `Running in CI environment: ${JSON.stringify(ciContextResult.ciContext, null, 2)}`,
    });
  }

  let runningServer: ServerType | undefined = undefined;

  const app = createHonoApp(runManager);

  let commandExitCode: number = 0;

  /**
   * Clean up and exit. This function is called when:
   * * the process receives a signal, or
   * * the command has finished executing
   */
  async function cleanup() {
    // End any runs that haven't already been ended
    await runManager.endAllRuns();

    // Shut down the server
    runningServer?.close();

    // Exit with code 1 if there were any uncaught errors
    if (runManager.hasUncaughtErrors()) {
      process.exit(1);
    }

    // Exit with code 1 if there were any failed evaluations and
    // the user has requested a non-zero exit code on evaluation failure
    if (runManager.hasAnyFailedEvaluations() && args.exit1OnEvaluationFailure) {
      process.exit(1);
    }

    // Exit with the underlying command's exit code
    process.exit(commandExitCode);
  }

  // Attempt to clean up when the process receives a signal
  ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach((signal) =>
    process.on(signal, cleanup),
  );

  const port = await findAvailablePort({ startPort: args.port });
  runningServer = serve(
    {
      fetch: app.fetch,
      port,
    },
    (addressInfo) => {
      const serverAddress = `http://localhost:${addressInfo.port}`;

      emitter.emit(EventName.CONSOLE_LOG, {
        ctx: 'cli',
        level: 'info',
        message: `Listening on ${serverAddress}`,
      });

      emitter.emit(EventName.CONSOLE_LOG, {
        ctx: 'cli',
        level: 'info',
        message: `Running command: ${args.command} ${args.commandArgs.join(' ')}`,
      });

      // Execute the command
      execCommand(args.command, args.commandArgs, {
        env: makeSDKEnvVars({
          [SDKEnvironmentVariable.AUTOBLOCKS_API_KEY]: args.apiKey,
          [SDKEnvironmentVariable.AUTOBLOCKS_V2_CI_TEST_RUN_BUILD_ID]:
            ciContextResult?.buildId,
          [SDKEnvironmentVariable.AUTOBLOCKS_CLI_SERVER_ADDRESS]: serverAddress,
          [SDKEnvironmentVariable.AUTOBLOCKS_FILTERS_TEST_SUITES]:
            args.testSuites,
          [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_TESTS_AND_HASHES]:
            ciContextResult?.ciContext?.autoblocksOverrides?.testsAndHashes,
          [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_PROMPT_REVISIONS]:
            ciContextResult?.ciContext?.autoblocksOverrides?.promptRevisions,
          [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_CONFIG_REVISIONS]:
            ciContextResult?.ciContext?.autoblocksOverrides?.configRevisions,
        }),
        // will return error code as response (even if it's non-zero)
        ignoreReturnCode: true,
        silent: true,
        listeners: {
          stdline: (data: string) => {
            emitter.emit(EventName.CONSOLE_LOG, {
              ctx: 'cmd',
              level: 'info',
              message: data,
            });
          },
          errline: (data: string) => {
            emitter.emit(EventName.CONSOLE_LOG, {
              ctx: 'cmd',
              level: 'info',
              message: data,
            });
          },
        },
      })
        .then((exitCode) => {
          commandExitCode = exitCode;
        })
        .catch(() => {
          commandExitCode = 1;
        })
        .finally(async () => {
          runManager.setEndTime();

          // Post comments to Slack and GitHub (if set up)
          // Note: this doesn't happen in cleanup() because that
          // function is also called during unexpected termination
          // and makes a best effort to clean up resources, whereas
          // we only want to post comments if the command has
          // successfully executed.
          await runManager.postComments({
            slackWebhookUrl: args.slackWebhookUrl,
          });

          await cleanup();
        });
    },
  );
}
