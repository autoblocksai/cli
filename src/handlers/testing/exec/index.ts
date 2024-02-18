import { exec as execCommand } from '@actions/exec';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server/dist/types';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import net from 'net';
import { z } from 'zod';
import { startInteractiveCLI } from './interactive-cli';
import { EventName, emitter } from './emitter';

interface TestCaseEvent {
  testExternalId: string;
  testCaseHash: string;
  event: {
    message: string;
    traceId: string;
    timestamp: string;
    properties?: unknown;
  };
}

interface UncaughtError {
  testExternalId: string;
  // Will be defined if the error occurred within a certain test case
  testCaseHash?: string;
  // Will be defined if the error occurred within a certain evaluator
  evaluatorExternalId?: string;
  error: {
    name: string;
    message: string;
    stacktrace: string;
  };
}

/**
 * Manages the state of the current run
 */
class RunManager {
  private readonly apiKey: string;
  private readonly message: string | undefined;
  readonly isInteractive: boolean;

  /**
   * Keep a map of each test's external ID to its run ID
   *
   * (we create a run for each test)
   */
  private testExternalIdToRunId: Record<string, string>;

  /**
   * Keep a map of test case hashes to their result IDs
   *
   * testExternalId -> testCaseHash -> testCaseResultId
   */
  private testCaseHashToResultId: Record<string, Record<string, string>>;

  /**
   * Accumulate events for the duration of the run
   */
  private testCaseEvents: TestCaseEvent[];

  /**
   * Keep track of uncaught errors
   */
  uncaughtErrors: UncaughtError[];

  /**
   * Keep track of whether or not there was ever an evaluation that did not pass
   *
   * This is used to determine the final exit code of the process
   */
  hasAnyFailedEvaluations: boolean;

  constructor(args: {
    apiKey: string;
    runMessage: string | undefined;
    isInteractive: boolean;
  }) {
    this.apiKey = args.apiKey;
    this.message = args.runMessage;
    this.isInteractive = args.isInteractive;

    this.testExternalIdToRunId = {};
    this.testCaseHashToResultId = {};
    this.testCaseEvents = [];
    this.uncaughtErrors = [];
    this.hasAnyFailedEvaluations = false;
  }

  async findAvailablePort(args: { startPort: number }): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryListening = (port: number) => {
        const server = net.createServer();

        server.listen(port, () => {
          server.once('close', () => {
            if (port !== args.startPort) {
              this.logger.log(`Listening on port ${port}`);
            }
            resolve(port);
          });
          server.close();
        });

        server.on('error', (err) => {
          if ((err as { code?: string } | undefined)?.code === 'EADDRINUSE') {
            this.logger.log(`Port ${port} is in use, trying port ${port + 1}`);
            tryListening(port + 1);
          } else {
            reject(err);
          }
        });
      };

      tryListening(args.startPort);
    });
  }

  private get logger() {
    return {
      debug: (...args: unknown[]) => {
        if (this.isInteractive) {
          // TODO: emit to interactive CLI
        } else {
          // eslint-disable-next-line no-console
          console.debug(...args);
        }
      },
      log: (...args: unknown[]) => {
        if (this.isInteractive) {
          // TODO: emit to interactive CLI
        } else {
          // eslint-disable-next-line no-console
          console.log(...args);
        }
      },
      warn: (...args: unknown[]) => {
        if (this.isInteractive) {
          // TODO: emit to interactive CLI
        } else {
          // eslint-disable-next-line no-console
          console.warn(...args);
        }
      },
    };
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const resp = await fetch(`https://api.autoblocks.ai${path}`, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    if (!resp.ok) {
      throw new Error(
        `POST ${path} failed: ${resp.status} ${await resp.text()}`,
      );
    }
    return resp.json();
  }

  async handleStartRun(args: { testExternalId: string }): Promise<string> {
    const { id } = await this.post<{ id: string }>('/testing/local/runs', {
      testExternalId: args.testExternalId,
      message: this.message,
    });
    this.testExternalIdToRunId[args.testExternalId] = id;
    return id;
  }

  async handleEndRun(args: { testExternalId: string }): Promise<void> {
    emitter.emit(EventName.RUN_ENDED, { testExternalId: args.testExternalId });
    const runId = this.currentRunId({ testExternalId: args.testExternalId });
    await this.post(`/testing/local/runs/${runId}/end`);
    delete this.testExternalIdToRunId[args.testExternalId];
  }

  async endAllRuns() {
    const testIdsToEnd = Object.keys(this.testExternalIdToRunId);
    await Promise.allSettled(
      testIdsToEnd.map((testExternalId) => {
        return this.handleEndRun({ testExternalId });
      }),
    );
  }

  private currentRunId(args: { testExternalId: string }): string {
    const runId = this.testExternalIdToRunId[args.testExternalId];
    if (!runId) {
      throw new Error(
        `No run ID found for test external ID ${args.testExternalId}`,
      );
    }
    return runId;
  }

  handleTestCaseEvent(event: {
    testExternalId: string;
    testCaseHash: string;
    event: {
      message: string;
      traceId: string;
      timestamp: string;
      properties?: unknown;
    };
  }) {
    this.testCaseEvents.push(event);
  }

  handleUncaughtError(args: {
    testExternalId: string;
    testCaseHash?: string;
    evaluatorExternalId?: string;
    error: {
      name: string;
      message: string;
      stacktrace: string;
    };
  }) {
    this.uncaughtErrors.push(args);
  }

  async handleTestCaseResult(args: {
    testExternalId: string;
    testCaseHash: string;
    testCaseBody?: unknown;
    testCaseOutput?: unknown;
  }) {
    const events = this.testCaseEvents.filter(
      (e) =>
        e.testExternalId === args.testExternalId &&
        e.testCaseHash === args.testCaseHash,
    );
    const runId = this.currentRunId({
      testExternalId: args.testExternalId,
    });
    const { id: resultId } = await this.post<{ id: string }>(
      `/testing/local/runs/${runId}/results`,
      {
        testCaseHash: args.testCaseHash,
        testCaseBody: args.testCaseBody,
        testCaseOutput: args.testCaseOutput,
        testCaseEvents: events,
      },
    );
    if (!this.testCaseHashToResultId[args.testExternalId]) {
      this.testCaseHashToResultId[args.testExternalId] = {};
    }
    this.testCaseHashToResultId[args.testExternalId][args.testCaseHash] =
      resultId;
  }

  private evaluationPassed(args: {
    score: number;
    threshold: {
      lt?: number;
      lte?: number;
      gt?: number;
      gte?: number;
    };
  }): boolean {
    const results: boolean[] = [];
    if (args.threshold.lt !== undefined) {
      results.push(args.score < args.threshold.lt);
    }
    if (args.threshold.lte !== undefined) {
      results.push(args.score <= args.threshold.lte);
    }
    if (args.threshold.gt !== undefined) {
      results.push(args.score > args.threshold.gt);
    }
    if (args.threshold.gte !== undefined) {
      results.push(args.score >= args.threshold.gte);
    }
    return results.every((r) => r);
  }

  async handleTestCaseEval(args: {
    testExternalId: string;
    testCaseHash: string;
    evaluatorExternalId: string;
    score: number;
    threshold?: {
      lt?: number;
      lte?: number;
      gt?: number;
      gte?: number;
    };
  }): Promise<void> {
    let passed: boolean | undefined = undefined;
    if (args.threshold) {
      passed = this.evaluationPassed({
        score: args.score,
        threshold: args.threshold,
      });
    }

    emitter.emit(EventName.EVALUATION, {
      ...args,
      // The interactive CLI uses null to differentiate between
      // "not run yet" and "has no pass / fail status"
      passed: passed === undefined ? null : passed,
    });

    const testCaseResultId =
      this.testCaseHashToResultId[args.testExternalId]?.[args.testCaseHash];

    if (!testCaseResultId) {
      this.logger.warn(
        `No corresponding test case result ID for test case hash ${args.testCaseHash}`,
      );
      return;
    }

    const runId = this.currentRunId({
      testExternalId: args.testExternalId,
    });

    await this.post(
      `/testing/local/runs/${runId}/results/${testCaseResultId}/evaluations`,
      {
        evaluatorExternalId: args.evaluatorExternalId,
        score: args.score,
        passed,
        threshold: args.threshold,
      },
    );

    if (passed === false) {
      this.hasAnyFailedEvaluations = true;
    }
  }
}

/**
 * Server that receives requests from the SDKs
 */
function createHonoApp(runManager: RunManager): Hono {
  const app = new Hono();

  app.post(
    '/start',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
      }),
    ),
    async (c) => {
      const data = c.req.valid('json');
      await runManager.handleStartRun(data);
      return c.json('ok');
    },
  );

  app.post(
    '/end',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
      }),
    ),
    async (c) => {
      const data = c.req.valid('json');
      await runManager.handleEndRun(data);
      return c.json('ok');
    },
  );

  app.post(
    '/events',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
        testCaseHash: z.string(),
        event: z.object({
          message: z.string(),
          traceId: z.string(),
          timestamp: z.string(),
          properties: z.unknown(),
        }),
      }),
    ),
    async (c) => {
      const data = c.req.valid('json');
      runManager.handleTestCaseEvent(data);
      return c.json('ok');
    },
  );

  app.post(
    '/errors',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
        testCaseHash: z
          .string()
          .nullish()
          .transform((x) => x ?? undefined),
        evaluatorExternalId: z
          .string()
          .nullish()
          .transform((x) => x ?? undefined),
        error: z.object({
          name: z.string(),
          message: z.string(),
          stacktrace: z.string(),
        }),
      }),
    ),
    async (c) => {
      const data = c.req.valid('json');
      runManager.handleUncaughtError(data);
      return c.json('ok');
    },
  );

  app.post(
    '/results',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
        testCaseHash: z.string(),
        testCaseBody: z.unknown(),
        testCaseOutput: z.unknown(),
      }),
    ),
    async (c) => {
      const data = c.req.valid('json');
      await runManager.handleTestCaseResult(data);
      return c.json('ok');
    },
  );

  app.post(
    '/evals',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
        testCaseHash: z.string(),
        evaluatorExternalId: z.string(),
        score: z.number(),
        threshold: z
          .object({
            lt: z
              .number()
              .nullish()
              .transform((x) => x ?? undefined),
            lte: z
              .number()
              .nullish()
              .transform((x) => x ?? undefined),
            gt: z
              .number()
              .nullish()
              .transform((x) => x ?? undefined),
            gte: z
              .number()
              .nullish()
              .transform((x) => x ?? undefined),
          })
          .nullish()
          .transform((x) => x ?? undefined),
      }),
    ),
    async (c) => {
      const data = c.req.valid('json');
      await runManager.handleTestCaseEval(data);
      return c.json('ok');
    },
  );

  return app;
}

/**
 * Exec command while local server is running
 */
export async function exec(args: {
  command: string;
  commandArgs: string[];
  apiKey: string;
  runMessage: string | undefined;
  interactive: boolean;
  port: number;
  exit1OnEvaluationFailure: boolean;
}) {
  const runManager = new RunManager({
    apiKey: args.apiKey,
    runMessage: args.runMessage,
    isInteractive: args.interactive,
  });

  if (runManager.isInteractive) {
    startInteractiveCLI();
  }

  let runningServer: ServerType | undefined = undefined;

  const port = await runManager.findAvailablePort({ startPort: args.port });
  const app = createHonoApp(runManager);

  let commandExitCode: number = 0;

  async function cleanup() {
    await runManager.endAllRuns();

    runningServer?.close();

    if (runManager.uncaughtErrors.length > 0) {
      // Display errors
      for (const error of runManager.uncaughtErrors) {
        // eslint-disable-next-line no-console
        console.error(error);
      }
      process.exit(1);
    }

    if (runManager.hasAnyFailedEvaluations && args.exit1OnEvaluationFailure) {
      process.exit(1);
    }

    process.exit(commandExitCode);
  }

  runningServer = serve(
    {
      fetch: app.fetch,
      port,
    },
    (addressInfo) => {
      const serverAddress = `http://localhost:${addressInfo.port}`;

      // Set environment variables for the SDKs to use
      const env = {
        ...process.env,
        AUTOBLOCKS_CLI_SERVER_ADDRESS: serverAddress,
      };

      // Execute the command
      execCommand(args.command, args.commandArgs, {
        env,
        // will return error code as response (even if it's non-zero)
        ignoreReturnCode: true,
        silent: args.interactive,
      })
        .then((exitCode) => {
          commandExitCode = exitCode;
        })
        .catch(() => {
          commandExitCode = 1;
        })
        .finally(async () => {
          await cleanup();
        });
    },
  );

  ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach((signal) =>
    process.on(signal, cleanup),
  );
}
