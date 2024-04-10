import { serve } from '@hono/node-server';
import { renderApp } from './components/App';
import { createHonoApp } from './util/hono-app';
import { runCommandInAlignmentMode } from './util/run-command';
import { SessionManager } from './util/session-manager';
import { faker } from '@faker-js/faker';

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
        testCaseHashes: sessionManager.getTestCaseHashes(),
        requestNextTestCaseResult: async (testCaseHash: string) => {
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

          // Simulate a test case result from the SDK
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          sessionManager.handleTestCaseResult({
            testExternalId: args.testExternalId,
            testCaseHash,
            testCaseBody: {
              input: faker.lorem.sentence(),
              expected_substrings: Array.from(
                { length: faker.number.int({ min: 3, max: 5 }) },
                () => faker.lorem.word(),
              ),
            },
            testCaseOutput: faker.lorem.paragraphs(5, '\n\n'),
          });
        },
        onTestCaseResultGraded: async (args) => {
          await sessionManager.handleTestCaseResultGrade(args);
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
