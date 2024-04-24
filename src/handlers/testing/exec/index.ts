import { exec as execCommand } from '@actions/exec';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server/dist/types';
import { renderTestProgress } from './components/progress';
import { EventName, emitter } from './util/emitter';
import { findAvailablePort } from './util/net';
import { RunManager } from './util/run-manager';
import { createHonoApp } from './util/hono-app';

/**
 * Exec command while local server is running
 */
export async function exec(args: {
  command: string;
  commandArgs: string[];
  apiKey: string;
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

  const ciContext = await runManager.setupCIContext();

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

  if (ciContext) {
    emitter.emit(EventName.CONSOLE_LOG, {
      ctx: 'cli',
      level: 'debug',
      message: `Running in CI environment: ${JSON.stringify(ciContext, null, 2)}`,
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

      // Set environment variables for the SDKs to use
      const commandEnv: Record<string, string> = {
        ...process.env,
        AUTOBLOCKS_CLI_SERVER_ADDRESS: serverAddress,
      };
      if (ciContext?.promptSnapshots) {
        // The prompt SDKs will use this environment variable to know that they
        // need to pull down and use prompt snapshot(s)
        commandEnv.AUTOBLOCKS_PROMPT_SNAPSHOTS = JSON.stringify(
          ciContext.promptSnapshots,
        );
      }

      // Execute the command
      execCommand(args.command, args.commandArgs, {
        env: commandEnv,
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

          if (args.slackWebhookUrl) {
            // Post to Slack if a webhook URL has been set.
            // Note: this doesn't happen in cleanup() because that
            // function is also called during unexpected termination
            // and makes a best effort to clean up resources, whereas
            // we only want to post to Slack if the command has
            // successfully executed.
            await runManager.postSlackMessage({
              webhookUrl: args.slackWebhookUrl,
            });
          }

          await cleanup();
        });
    },
  );
}
