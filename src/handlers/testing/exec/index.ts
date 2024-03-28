import { exec as execCommand } from '@actions/exec';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server/dist/types';
import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';

import { z, type SafeParseReturnType } from 'zod';
import { renderTestProgress } from './components/progress';
import { EventName, emitter, type EventSchemas } from './util/emitter';
import { makeCIContext, type CIContext } from './util/ci';
import { findAvailablePort } from './util/net';
import { AUTOBLOCKS_API_BASE_URL } from '../../../util/constants';
import type { Evaluation, TestCaseEvent } from './util/models';
import { postSlackMessage } from './util/slack';

type UncaughtError = EventSchemas[EventName.UNCAUGHT_ERROR];

/**
 * Manages the state of the current run
 */
class RunManager {
  private readonly apiKey: string;
  private readonly message: string | undefined;

  private readonly startTime: Date;
  private endTime: Date | undefined = undefined;

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
  private uncaughtErrors: UncaughtError[];

  /**
   * Keep track of evaluations
   */
  private evaluations: Evaluation[];

  /**
   * The CI context, parsed from environment variables and local git data.
   */
  private ciContext: CIContext | undefined;

  /**
   * Only relevant for CI runs. These are returned from our REST API
   * when we POST to /builds at the beginning of a build on CI.
   * It's used in subsequent requests to associate runs with the build.
   */
  private ciBuildId: string | undefined;
  private ciBranchId: string | undefined;

  constructor(args: { apiKey: string; runMessage: string | undefined }) {
    this.apiKey = args.apiKey;
    this.message = args.runMessage;
    this.startTime = new Date();

    this.testExternalIdToRunId = {};
    this.testCaseHashToResultId = {};
    this.testCaseEvents = [];
    this.uncaughtErrors = [];
    this.evaluations = [];
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const subpath = this.isCI ? '/testing/ci' : '/testing/local';
    const resp = await fetch(`${AUTOBLOCKS_API_BASE_URL}${subpath}${path}`, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(`POST ${subpath}${path} failed: ${JSON.stringify(data)}`);
    }
    return data;
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

  async setupCIContext(): Promise<CIContext | null> {
    const ciContext = await this.makeCIContext();

    if (!ciContext) {
      return null;
    }

    emitter.emit(EventName.CONSOLE_LOG, {
      ctx: 'cli',
      level: 'debug',
      message: `Running in CI environment: ${JSON.stringify(ciContext, null, 2)}`,
    });

    const { id, branchId } = await this.post<{ id: string; branchId: string }>(
      '/builds',
      {
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
        commitCommitterName: ciContext.commitCommitterName,
        commitCommitterEmail: ciContext.commitCommitterEmail,
        commitAuthorName: ciContext.commitAuthorName,
        commitAuthorEmail: ciContext.commitAuthorEmail,
        commitCommittedDate: ciContext.commitCommittedDate,
        pullRequestNumber: ciContext.pullRequestNumber,
        pullRequestTitle: ciContext.pullRequestTitle,
        promptSnapshots: ciContext.promptSnapshots,
      },
    );

    this.ciBuildId = id;
    this.ciBranchId = branchId;

    return ciContext;
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

  /**
   * Used during cleanup to ensure all runs are ended in case the process
   * terminates prematurely.
   */
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
    let passed: boolean | null;

    // A pass/fail status is only set if there is a threshold
    if (args.threshold) {
      passed = this.evaluationPassed({
        score: args.score,
        threshold: args.threshold,
      });
    } else {
      passed = null;
    }

    emitter.emit(EventName.EVALUATION, {
      ...args,
      passed,
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

    this.evaluations.push({
      testExternalId: args.testExternalId,
      evaluatorExternalId: args.evaluatorExternalId,
      testCaseHash: args.testCaseHash,
      passed,
    });
  }

  hasUncaughtErrors(): boolean {
    return this.uncaughtErrors.length > 0;
  }

  hasAnyFailedEvaluations(): boolean {
    return this.evaluations.some((e) => e.passed === false);
  }

  setEndTime() {
    if (this.endTime) {
      throw new Error('End time already set');
    }
    this.endTime = new Date();
  }

  async postSlackMessage(args: { webhookUrl: string }) {
    if (
      !this.ciBranchId ||
      !this.ciBuildId ||
      !this.ciContext ||
      !this.endTime ||
      this.evaluations.length === 0
    ) {
      const nameToMissing = {
        ciBranchId: !this.ciBranchId,
        ciBuildId: !this.ciBuildId,
        ciContext: !this.ciContext,
        endTime: !this.endTime,
        evaluations: this.evaluations.length === 0,
      };
      emitter.emit(EventName.CONSOLE_LOG, {
        ctx: 'cli',
        level: 'error',
        message: `Can't post to Slack because some required data is missing: ${JSON.stringify(nameToMissing)}`,
      });
      return;
    }

    try {
      await postSlackMessage({
        webhookUrl: args.webhookUrl,
        buildId: this.ciBuildId,
        branchId: this.ciBranchId,
        ciContext: this.ciContext,
        runDurationMs: this.endTime.getTime() - this.startTime.getTime(),
        evaluations: this.evaluations,
      });
    } catch (err) {
      emitter.emit(EventName.CONSOLE_LOG, {
        ctx: 'cli',
        level: 'error',
        message: `Failed to post to Slack: ${err}`,
      });
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
  slackWebhookUrl: string | undefined;
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

  const ciContext = await runManager.setupCIContext();

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
