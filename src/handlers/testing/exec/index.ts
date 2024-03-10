import { exec as execCommand } from '@actions/exec';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server/dist/types';
import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';

import { z, type SafeParseReturnType } from 'zod';
import { renderTestProgress } from './components/progress';
import { EventName, emitter, type EventSchemas } from './emitter';
import { makeCIContext, type CIContext } from './util/ci';
import { findAvailablePort } from './util/net';

type UncaughtError = EventSchemas[EventName.UNCAUGHT_ERROR];

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

/**
 * Manages the state of the current run
 */
class RunManager {
  private readonly apiKey: string;
  private readonly message: string | undefined;

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

  /**
   * The CI context, parsed from environment variables and local git data.
   */
  private ciContext: CIContext | undefined;

  /**
   * Only relevant for CI runs. This is returned from our REST API
   * when we POST to /builds at the beginning of a build on CI.
   * It's used in subsequent requests to associate runs with the build.
   */
  private ciBuildId: string | undefined;

  constructor(args: { apiKey: string; runMessage: string | undefined }) {
    this.apiKey = args.apiKey;
    this.message = args.runMessage;

    this.testExternalIdToRunId = {};
    this.testCaseHashToResultId = {};
    this.testCaseEvents = [];
    this.uncaughtErrors = [];
    this.hasAnyFailedEvaluations = false;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const subpath = this.isCI ? '/testing/ci' : '/testing/local';
    const resp = await fetch(`https://api.autoblocks.ai${subpath}${path}`, {
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

  private get isCI(): boolean {
    return process.env.CI === 'true';
  }

  async makeCIContext(): Promise<CIContext | undefined> {
    if (!this.isCI) {
      return undefined;
    }
    if (!this.ciContext) {
      try {
        this.ciContext = await makeCIContext();
      } catch (err) {
        emitter.emit(EventName.CONSOLE_LOG, {
          ctx: 'cli',
          level: 'error',
          message: `Failed to get CI context: ${err}`,
        });
        throw err;
      }
    }
    return this.ciContext;
  }

  async setup(): Promise<void> {
    const ciContext = await this.makeCIContext();

    if (!ciContext) {
      return;
    }

    emitter.emit(EventName.CONSOLE_LOG, {
      ctx: 'cli',
      level: 'debug',
      message: `Running in CI environment: ${JSON.stringify(ciContext, null, 2)}`,
    });

    const { id } = await this.post<{ id: string }>('/builds', {
      gitProvider: ciContext.gitProvider,
      repositoryExternalId: ciContext.repoId,
      repositoryName: ciContext.repoName,
      repositoryHtmlUrl: ciContext.repoHtmlUrl,
      branchExternalId: ciContext.branchId,
      branchName: ciContext.branchName,
      isDefaultBranch: ciContext.branchName === ciContext.defaultBranchName,
      ciProvider: ciContext.ciProvider,
      buildHtmlUrl: ciContext.buildHtmlUrl,
      commitSha: ciContext.commitSha,
      commitMessage: ciContext.commitMessage,
      commitComitterName: ciContext.commitCommitterName,
      commitCommitterEmail: ciContext.commitCommitterEmail,
      commitAuthorName: ciContext.commitAuthorName,
      commitAuthorEmail: ciContext.commitAuthorEmail,
      commitCommittedDate: ciContext.commitCommittedDate,
      pullRequestNumber: ciContext.pullRequestNumber,
      pullRequestTitle: ciContext.pullRequestTitle,
    });

    this.ciBuildId = id;
  }

  async handleStartRun(args: { testExternalId: string }): Promise<string> {
    emitter.emit(EventName.RUN_STARTED, {
      testExternalId: args.testExternalId,
    });
    const { id } = await this.post<{ id: string }>('/runs', {
      testExternalId: args.testExternalId,
      message: this.message,
      buildId: this.ciBuildId,
    });
    this.testExternalIdToRunId[args.testExternalId] = id;
    return id;
  }

  async handleEndRun(args: { testExternalId: string }): Promise<void> {
    emitter.emit(EventName.RUN_ENDED, { testExternalId: args.testExternalId });

    try {
      const runId = this.currentRunId({ testExternalId: args.testExternalId });
      await this.post(`/runs/${runId}/end`);
    } finally {
      delete this.testExternalIdToRunId[args.testExternalId];
    }
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
    emitter.emit(EventName.CONSOLE_LOG, {
      ctx: 'cmd',
      level: 'error',
      message: JSON.stringify(args, null, 2),
    });
    emitter.emit(EventName.UNCAUGHT_ERROR, args);
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
      `/runs/${runId}/results`,
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
    metadata?: unknown;
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
      // The test case progress component uses null to differentiate between
      // "not run yet" and "has no pass / fail status"
      passed: passed === undefined ? null : passed,
    });

    const testCaseResultId =
      this.testCaseHashToResultId[args.testExternalId]?.[args.testCaseHash];

    if (!testCaseResultId) {
      throw new Error(
        `No corresponding test case result ID for test case hash ${args.testCaseHash}`,
      );
    }

    const runId = this.currentRunId({
      testExternalId: args.testExternalId,
    });

    await this.post(`/runs/${runId}/results/${testCaseResultId}/evaluations`, {
      evaluatorExternalId: args.evaluatorExternalId,
      score: args.score,
      passed,
      threshold: args.threshold,
      metadata: args.metadata,
    });

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

  app.onError((err, c) => {
    emitter.emit(EventName.CONSOLE_LOG, {
      ctx: 'cli',
      level: 'error',
      message: `${c.req.method} ${c.req.path}: ${err.message}`,
    });
    return c.json('Internal Server Error', 500);
  });

  const handleValidationResult = (
    result: SafeParseReturnType<unknown, unknown>,
    c: Context,
  ) => {
    if (!result.success) {
      emitter.emit(EventName.CONSOLE_LOG, {
        ctx: 'cli',
        level: 'error',
        message: `${c.req.method} ${c.req.path}: ${result.error}`,
      });
      return c.json('Bad Request', 400);
    }
  };

  app.get('/', (c) => {
    return c.text('👋');
  });

  app.post(
    '/start',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
      }),
      handleValidationResult,
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
      handleValidationResult,
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
      handleValidationResult,
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
      handleValidationResult,
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
      handleValidationResult,
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
        metadata: z
          .unknown()
          .nullish()
          .transform((x) => x ?? undefined),
      }),
      handleValidationResult,
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
  port: number;
  exit1OnEvaluationFailure: boolean;
}) {
  let listenersCreated = false;
  renderTestProgress({ onListenersCreated: () => (listenersCreated = true) });

  // Wait for listeners to be created before starting the server
  while (!listenersCreated) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const runManager = new RunManager({
    apiKey: args.apiKey,
    runMessage: args.runMessage,
  });

  await runManager.setup();

  let runningServer: ServerType | undefined = undefined;

  const app = createHonoApp(runManager);

  let commandExitCode: number = 0;

  async function cleanup() {
    await runManager.endAllRuns();

    runningServer?.close();

    if (runManager.uncaughtErrors.length > 0) {
      process.exit(1);
    }

    if (runManager.hasAnyFailedEvaluations && args.exit1OnEvaluationFailure) {
      process.exit(1);
    }

    process.exit(commandExitCode);
  }

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
        // Set environment variables for the SDKs to use
        env: {
          ...process.env,
          AUTOBLOCKS_CLI_SERVER_ADDRESS: serverAddress,
        },
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
          await cleanup();
        });
    },
  );

  ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach((signal) =>
    process.on(signal, cleanup),
  );
}
