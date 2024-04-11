import { serve } from '@hono/node-server';
import { renderApp } from './components/App';
import { createHonoApp } from './util/hono-app';
import { runCommandInAlignmentMode } from './util/run-command';
import { SessionManager } from './util/session-manager';

export async function align(args: {
  command: string;
  commandArgs: string[];
  apiKey: string;
  port: number;
  testExternalId: string;
}) {
  const sessionManager = new SessionManager({
    apiKey: args.apiKey,
    testExternalId: args.testExternalId,
  });
  await sessionManager.start();

  const app = createHonoApp(sessionManager);

  const runningServer = serve(
    {
      fetch: app.fetch,
      port: args.port,
    },
    (addressInfo) => {
      const serverAddress = `http://localhost:${addressInfo.port}`;

      renderApp({
        testExternalId: args.testExternalId,
        sessionId: sessionManager.getSessionId(),
        // This is a function instead of a list because the hashes will change
        // between the first run (it will be empty because we haven't received the
        // response from /info yet) and the second run where we will have the hashes
        testCaseHashes: () => sessionManager.getTestCaseHashes(),
        requestNextTestCaseResult: async ({
          testCaseHash,
        }: {
          testCaseHash: string | undefined;
        }) => {
          // Clear out any events from past test case runs
          sessionManager.resetTestCaseEvents();

          // Run the command in "alignment mode", aka filtered
          // down to the given test case
          await runCommandInAlignmentMode({
            command: args.command,
            commandArgs: args.commandArgs,
            cliServerAddress: serverAddress,
            testExternalId: args.testExternalId,
            testCaseHash,
          });
        },
        onTestCaseResultGraded: async (gradedResult) => {
          await sessionManager.handleGradedTestCaseResult(gradedResult);
        },
        autogenerateEvaluators: async () => {
          return sessionManager.autogenerateEvaluators();
        },
        onExit: () => {
          runningServer.close();
        },
      });
    },
  );
}
