import { CIContext, setupCIContext } from '../../../../util/ci';
import { EventSchemas, EventName, emitter } from './emitter';
import {
  type TestCaseEvent,
  type Evaluation,
  EvaluationPassed,
  type TestRun,
} from './models';
import { post } from '../../../../util/api';

type UncaughtError = EventSchemas[EventName.UNCAUGHT_ERROR];

export enum HumanReviewFieldContentType {
  TEXT = 'text',
  LINK = 'link',
  HTML = 'html',
  MARKDOWN = 'markdown',
}

/**
 * Manages the state of the current run
 */
export class RunManager {
  private readonly apiKey: string;
  private readonly message: string | undefined;
  private readonly includeShareUrl: boolean;
  private readonly startTime: Date;
  private endTime: Date | undefined = undefined;

  /**
   * Map of run ID to run metadata
   */
  private runs: Record<string, TestRun>;

  /**
   * Keep a map of each test's external ID to its run ID
   *
   * (we create a run for each test)
   *
   * TODO drop this once runId is being sent by the SDKs to each endpoint
   */
  private testExternalIdToRunId: Record<string, string>;

  /**
   * Keep a map of test case hashes to their result IDs
   *
   * runId -> testCaseHash -> testCaseResultId
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

  constructor(args: {
    apiKey: string;
    runMessage: string | undefined;
    includeShareUrl: boolean;
  }) {
    this.apiKey = args.apiKey;
    this.message = args.runMessage;
    this.includeShareUrl = args.includeShareUrl;
    this.startTime = new Date();

    this.runs = {};
    this.testExternalIdToRunId = {};
    this.testCaseHashToResultId = {};
    this.testCaseEvents = [];
    this.uncaughtErrors = [];
    this.evaluations = [];
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const subpath = this.isCI ? '/testing/ci' : '/testing/local';
    return await post({
      path: `${subpath}${path}`,
      apiKey: this.apiKey,
      body,
    });
  }

  private get isCI(): boolean {
    return process.env.CI === 'true';
  }

  async setupCIContext(): Promise<{
    buildId: string;
    branchId: string;
    ciContext: CIContext;
  } | null> {
    if (!this.isCI) {
      return null;
    }

    // If we already have the CI context, build ID, and branch ID, we can skip the setup
    if (this.ciContext && this.ciBuildId && this.ciBranchId) {
      return {
        buildId: this.ciBuildId,
        branchId: this.ciBranchId,
        ciContext: this.ciContext,
      };
    }

    try {
      const result = await setupCIContext({ apiKey: this.apiKey });
      if (result) {
        this.ciBuildId = result.buildId;
        this.ciBranchId = result.branchId;
        this.ciContext = result.ciContext;
      }
      return result;
    } catch (err) {
      emitter.emit(EventName.CONSOLE_LOG, {
        ctx: 'cli',
        level: 'error',
        message: `Failed to setup CI context: ${err}`,
      });
      throw err;
    }
  }

  getCIBranchId(): string | undefined {
    return this.ciBranchId;
  }

  getCIBuildId(): string | undefined {
    return this.ciBuildId;
  }

  async handleCreateGrid(args: {
    gridSearchParams: Record<string, unknown[]>;
  }): Promise<string> {
    const { id } = await this.post<{ id: string }>('/grids', {
      gridSearchParams: args.gridSearchParams,
    });
    return id;
  }

  async handleStartRun(args: {
    testExternalId: string;
    gridSearchRunGroupId?: string;
    gridSearchParamsCombo?: Record<string, unknown> | null;
  }): Promise<string> {
    // Create the run
    const { id } = await this.post<{ id: string }>('/runs', {
      testExternalId: args.testExternalId,
      message: this.message,
      buildId: this.ciBuildId,
      gridSearchRunGroupId: args.gridSearchRunGroupId,
      gridSearchParamsCombo: args.gridSearchParamsCombo,
    });

    this.runs[id] = {
      startedAt: new Date().toISOString(),
      endedAt: undefined,
      runId: id,
      testExternalId: args.testExternalId,
      gridSearchParamsCombo: args.gridSearchParamsCombo || undefined,
    };

    // TODO drop this map once SDKs are updated to pass run ID to every endpoint
    this.testExternalIdToRunId[args.testExternalId] = id;

    // Emit run started to ink app
    emitter.emit(EventName.RUN_STARTED, {
      id,
      testExternalId: args.testExternalId,
      gridSearchRunGroupId: args.gridSearchRunGroupId,
      gridSearchParamsCombo: args.gridSearchParamsCombo || undefined,
    });

    // Return the ID so that the SDKs can pass the run ID along with
    // subsequent requests
    return id;
  }

  async handleEndRun(args: {
    // TODO drop testExternalId and make runId required argument
    testExternalId: string;
    runId?: string;
  }): Promise<void> {
    const runId = this.legacyGetCurrentRunId({
      testExternalId: args.testExternalId,
      runId: args.runId,
    });

    const shareUrl = await this.createShareUrl({ runId });

    emitter.emit(EventName.RUN_ENDED, {
      id: runId,
      testExternalId: args.testExternalId,
      shareUrl,
    });

    try {
      await this.post(`/runs/${runId}/end`);
    } finally {
      delete this.testExternalIdToRunId[args.testExternalId];
      this.runs[runId].endedAt = new Date().toISOString();
    }
  }

  /**
   * Used during cleanup to ensure all runs are ended in case the process
   * terminates prematurely.
   */
  async endAllRuns() {
    await Promise.allSettled(
      Object.values(this.runs)
        .filter((r) => !r.endedAt)
        .map((r) =>
          this.handleEndRun({
            testExternalId: r.testExternalId,
            runId: r.runId,
          }),
        ),
    );
  }

  /**
   * We used to maintain a test ID -> run ID map here in the CLI so that the SDKs didn't need to
   * maintain and pass around the run ID to every endpoint. But to support grid search, which creates
   * multiple runs per test suite in a single session, we need to return the run ID from /start and the
   * SDKs must send this run ID to every endpoint. To keep the CLI backwards compatible, we still maintain
   * the test ID -> run ID map while we wait for users to update their SDKs to the latest version.
   */
  private legacyGetCurrentRunId(args: {
    testExternalId: string;
    runId: string | undefined;
  }): string {
    // Use the runId if it's given, otherwise fall back to the test ID -> run ID map
    const runId = args.runId || this.testExternalIdToRunId[args.testExternalId];
    if (!runId) {
      throw new Error(
        `No run ID found for test external ID ${args.testExternalId}`,
      );
    }
    return runId;
  }

  private testCaseResultIdFromHash(args: {
    runId: string;
    testCaseHash: string;
  }): string {
    const testCaseResultId =
      this.testCaseHashToResultId[args.runId]?.[args.testCaseHash];
    if (!testCaseResultId) {
      throw new Error(
        `No corresponding test case result ID for test case hash ${args.testCaseHash}`,
      );
    }
    return testCaseResultId;
  }

  private async createShareUrl(args: { runId: string }) {
    // Share URL is only applicable for local runs
    // CI runs are always shareable
    if (this.isCI || !this.includeShareUrl) {
      return;
    }
    try {
      const { shareUrl } = await this.post<{ shareUrl: string }>(
        `/runs/${args.runId}/share-url`,
      );
      return shareUrl;
    } catch (err) {
      emitter.emit(EventName.CONSOLE_LOG, {
        ctx: 'cli',
        level: 'error',
        message: `Failed to create share URL: ${err}`,
      });
    }
  }

  handleTestCaseEvent(
    // TODO make runId required
    event: Omit<TestCaseEvent, 'runId'> & { runId?: string },
  ) {
    this.testCaseEvents.push({
      ...event,
      runId: this.legacyGetCurrentRunId({
        testExternalId: event.testExternalId,
        runId: event.runId,
      }),
    });
  }

  handleUncaughtError(args: {
    // Where the error originated from
    ctx: 'cmd' | 'cli';
    // Error
    error: {
      name: string;
      message: string;
      stacktrace: string;
    };
    // If originated from cmd, details about
    // which test suite, run, test case, and evaluator
    testExternalId?: string;
    runId?: string;
    testCaseHash?: string;
    evaluatorExternalId?: string;
  }) {
    const debugLines: string[] = [];

    if (args.testExternalId) {
      debugLines.push(`Test ID: ${args.testExternalId}`);
      try {
        debugLines.push(
          `Run ID: ${this.legacyGetCurrentRunId({ testExternalId: args.testExternalId, runId: args.runId })}`,
        );
      } catch {
        // Ignore
      }
    }
    if (args.testCaseHash) {
      debugLines.push(`Test Case Hash: ${args.testCaseHash}`);
      if (args.testExternalId) {
        try {
          debugLines.push(
            `Test Case Result ID: ${this.testCaseResultIdFromHash({
              runId: this.legacyGetCurrentRunId({
                testExternalId: args.testExternalId,
                runId: args.runId,
              }),
              testCaseHash: args.testCaseHash,
            })}`,
          );
        } catch {
          // Ignore
        }
      }
    }
    if (args.evaluatorExternalId) {
      debugLines.push(`Evaluator ID: ${args.evaluatorExternalId}`);
    }

    const msg: string[] = [`${args.error.name}: ${args.error.message}`];
    if (debugLines.length > 0) {
      msg.push('');
      msg.push('======= DEBUG INFO =======');
      msg.push(...debugLines);
    }

    if (args.error.stacktrace) {
      msg.push('');
      msg.push('======= STACKTRACE =======');
      msg.push(args.error.stacktrace);
    }

    emitter.emit(EventName.CONSOLE_LOG, {
      ctx: args.ctx,
      level: 'error',
      message: msg.join('\n'),
    });
    emitter.emit(EventName.UNCAUGHT_ERROR, args);
    this.uncaughtErrors.push(args);
  }

  async runUIBasedEvaluators(args: {
    testExternalId: string;
    runId: string;
    testCaseId: string;
    testCaseHash: string;
  }) {
    const runId = this.legacyGetCurrentRunId({
      testExternalId: args.testExternalId,
      runId: args.runId,
    });
    const { evaluationResults } = await this.post<{
      evaluationResults: {
        evaluatorExternalId: string;
        passed: boolean;
        score: number;
      }[];
    }>(`/runs/${runId}/results/${args.testCaseId}/ui-based-evaluations`);
    evaluationResults.forEach((result) => {
      const evaluation = {
        testExternalId: args.testExternalId,
        runId,
        evaluatorExternalId: result.evaluatorExternalId,
        testCaseHash: args.testCaseHash,
        passed: result.passed ? EvaluationPassed.TRUE : EvaluationPassed.FALSE,
        score: result.score,
      };
      emitter.emit(EventName.EVALUATION, evaluation);
      this.evaluations.push(evaluation);
    });
  }

  async handleTestCaseResult(args: {
    testExternalId: string;
    runId?: string;
    testCaseHash: string;
    datasetItemId?: string | null;
    testCaseBody: Record<string, unknown>;
    testCaseOutput?: unknown;
    testCaseDurationMs?: number | null;
    testCaseRevisionUsage?:
      | {
          entityExternalId: string;
          entityType: string;
          revisionId: string;
          usedAt: string;
        }[]
      | null;
    testCaseHumanReviewInputFields?:
      | {
          name: string;
          value: string;
          contentType?: HumanReviewFieldContentType | null;
        }[]
      | null;
    testCaseHumanReviewOutputFields?:
      | {
          name: string;
          value: string;
          contentType?: HumanReviewFieldContentType | null;
        }[]
      | null;
  }): Promise<{ resultId: string }> {
    const runId = this.legacyGetCurrentRunId({
      testExternalId: args.testExternalId,
      runId: args.runId,
    });

    const { id: resultId } = await this.post<{ id: string }>(
      `/runs/${runId}/results`,
      {
        testCaseHash: args.testCaseHash,
        testCaseDurationMs: args.testCaseDurationMs,
        testCaseRevisionUsage: args.testCaseRevisionUsage,
        datasetItemId: args.datasetItemId,
      },
    );

    if (!this.testCaseHashToResultId[runId]) {
      this.testCaseHashToResultId[runId] = {};
    }
    this.testCaseHashToResultId[runId][args.testCaseHash] = resultId;

    const events = this.testCaseEvents
      .filter(
        (e) =>
          e.testExternalId === args.testExternalId &&
          e.runId === runId &&
          e.testCaseHash === args.testCaseHash,
      )
      .map((e) => e.event);

    // We still want to try the other endpoints if 1 fails
    const results = await Promise.allSettled([
      this.post(`/runs/${runId}/results/${resultId}/body`, {
        testCaseBody: args.testCaseBody,
      }),
      this.post(`/runs/${runId}/results/${resultId}/output`, {
        testCaseOutput: args.testCaseOutput,
      }),
      this.post(`/runs/${runId}/results/${resultId}/events`, {
        testCaseEvents: events,
      }),
    ]);

    results.forEach((result) => {
      if (result.status === 'rejected') {
        emitter.emit(EventName.CONSOLE_LOG, {
          ctx: 'cli',
          level: 'warn',
          message: `Failed to send part of the test case results to Autoblocks for test case hash ${args.testCaseHash}: ${result.reason}`,
        });
      }
    });

    try {
      // Important that this is after we send in the body and output
      // that way we can infer human review fields from the body and output
      // if they weren't set by the user
      await this.post(
        `/runs/${runId}/results/${resultId}/human-review-fields`,
        {
          testCaseHumanReviewInputFields: args.testCaseHumanReviewInputFields,
          testCaseHumanReviewOutputFields: args.testCaseHumanReviewOutputFields,
        },
      );
    } catch (err) {
      emitter.emit(EventName.CONSOLE_LOG, {
        ctx: 'cli',
        level: 'warn',
        message: `Failed to send human review fields to Autoblocks for test case hash ${args.testCaseHash}: ${err}`,
      });
    }

    try {
      // Important that this is after human review fields since it uses them
      // If human review fields fails, we don't want to run this
      await this.runUIBasedEvaluators({
        testExternalId: args.testExternalId,
        runId,
        testCaseId: resultId,
        testCaseHash: args.testCaseHash,
      });
    } catch (err) {
      emitter.emit(EventName.CONSOLE_LOG, {
        ctx: 'cli',
        level: 'warn',
        message: `Failed to run AI evaluators created on the Autoblocks UI for test case hash ${args.testCaseHash}: ${err}`,
      });
    }

    return { resultId };
  }

  private determineIfEvaluationPassed(args: {
    score: number;
    threshold: {
      lt?: number;
      lte?: number;
      gt?: number;
      gte?: number;
    };
  }): EvaluationPassed {
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
    return results.every((r) => r)
      ? EvaluationPassed.TRUE
      : EvaluationPassed.FALSE;
  }

  async handleTestCaseEval(args: {
    testExternalId: string;
    runId?: string;
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
    revisionUsage?:
      | {
          entityExternalId: string;
          entityType: string;
          revisionId: string;
          usedAt: string;
        }[]
      | null;
    assertions?:
      | {
          passed: boolean;
          required: boolean;
          criterion: string;
          metadata?: unknown;
        }[]
      | null;
  }): Promise<void> {
    let passed: EvaluationPassed;

    if (args.threshold) {
      // A pass/fail status is only set if there is a threshold
      passed = this.determineIfEvaluationPassed({
        score: args.score,
        threshold: args.threshold,
      });
    } else {
      // Otherwise it's not applicable
      passed = EvaluationPassed.NOT_APPLICABLE;
    }

    const runId = this.legacyGetCurrentRunId({
      testExternalId: args.testExternalId,
      runId: args.runId,
    });

    emitter.emit(EventName.EVALUATION, {
      ...args,
      passed,
      runId,
    });

    const testCaseResultId = this.testCaseResultIdFromHash({
      runId,
      testCaseHash: args.testCaseHash,
    });

    // Our /evaluations endpoint expects `passed` to be either:
    // - true (passed)
    // - false (failed)
    // - undefined (not applicable)
    const passedForApi = {
      [EvaluationPassed.TRUE]: true,
      [EvaluationPassed.FALSE]: false,
      [EvaluationPassed.NOT_APPLICABLE]: undefined,
    }[passed];

    await this.post(`/runs/${runId}/results/${testCaseResultId}/evaluations`, {
      evaluatorExternalId: args.evaluatorExternalId,
      score: args.score,
      passed: passedForApi,
      threshold: args.threshold,
      metadata: args.metadata,
      revisionUsage: args.revisionUsage,
      assertions: args.assertions,
    });

    this.evaluations.push({
      testExternalId: args.testExternalId,
      runId,
      evaluatorExternalId: args.evaluatorExternalId,
      testCaseHash: args.testCaseHash,
      passed,
      score: args.score,
    });
  }

  hasUncaughtErrors(): boolean {
    return this.uncaughtErrors.length > 0;
  }

  hasAnyFailedEvaluations(): boolean {
    return this.evaluations.some((e) => e.passed === EvaluationPassed.FALSE);
  }

  setEndTime() {
    if (this.endTime) {
      throw new Error('End time already set');
    }
    this.endTime = new Date();
  }

  async postComments(args: { slackWebhookUrl: string | undefined }) {
    if (!this.isCI) {
      return;
    }

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
        level: 'warn',
        message: `Can't post comments because some required data is missing: ${JSON.stringify(nameToMissing)}`,
      });
      return;
    }

    const promises: Promise<unknown>[] = [];

    if (args.slackWebhookUrl) {
      Object.values(this.runs).forEach((run) => {
        const slackPromise = this.post(
          `/runs/${run.runId}/slack-notification`,
          {
            slackWebhookUrl: args.slackWebhookUrl,
          },
        )
          .then(() => {
            emitter.emit(EventName.CONSOLE_LOG, {
              ctx: 'cli',
              level: 'info',
              message: 'Successfully posted message to Slack',
            });
          })
          .catch((err) => {
            emitter.emit(EventName.CONSOLE_LOG, {
              ctx: 'cli',
              level: 'warn',
              message: `Failed to post to Slack: ${err}`,
            });
          });
        promises.push(slackPromise);
      });
    }

    if (process.env.GITHUB_TOKEN) {
      const gitHubPromise = this.post(
        `/builds/${this.ciBuildId}/github-comment`,
        {
          githubToken: process.env.GITHUB_TOKEN,
        },
      ).catch((err) => {
        emitter.emit(EventName.CONSOLE_LOG, {
          ctx: 'cli',
          level: 'warn',
          message: `Failed to post comment to GitHub: ${err}`,
        });
      });
      promises.push(gitHubPromise);
    }

    await Promise.allSettled(promises);
  }
}
