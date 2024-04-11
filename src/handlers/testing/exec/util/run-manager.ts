import { AUTOBLOCKS_API_BASE_URL } from '../../../../util/constants';
import { CIContext, makeCIContext } from './ci';
import { EventSchemas, EventName, emitter } from './emitter';
import {
  type TestCaseEvent,
  type Evaluation,
  EvaluationPassed,
} from './models';
import { postSlackMessage } from './slack';

type UncaughtError = EventSchemas[EventName.UNCAUGHT_ERROR];

/**
 * Manages the state of the current run
 */
export class RunManager {
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
      // Our API returns errors formated at JSON, so just throw
      // the stringified JSON
      throw new Error(JSON.stringify(data));
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

  handleTestCaseEvent(event: TestCaseEvent) {
    this.testCaseEvents.push(event);
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
    // which test suite, test case, and evaluator
    testExternalId?: string;
    testCaseHash?: string;
    evaluatorExternalId?: string;
  }) {
    emitter.emit(EventName.CONSOLE_LOG, {
      ctx: args.ctx,
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
    const events = this.testCaseEvents
      .filter(
        (e) =>
          e.testExternalId === args.testExternalId &&
          e.testCaseHash === args.testCaseHash,
      )
      .map((e) => e.event);
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
    return this.evaluations.some((e) => e.passed === EvaluationPassed.FALSE);
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
      emitter.emit(EventName.CONSOLE_LOG, {
        ctx: 'cli',
        level: 'info',
        message: 'Successfully posted message to Slack',
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