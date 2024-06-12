import { AUTOBLOCKS_API_BASE_URL } from '../../../../util/constants';
import { CIContext, makeCIContext } from './ci';
import { EventSchemas, EventName, emitter } from './emitter';
import {
  type TestCaseEvent,
  type Evaluation,
  EvaluationPassed,
} from './models';
import { postSlackMessage, postGitHubComment } from './comments';
import { z } from 'zod';

const zHttpError = z.object({
  status: z.number(),
  data: z.unknown(),
});

type HttpError = z.infer<typeof zHttpError>;

type UncaughtError = EventSchemas[EventName.UNCAUGHT_ERROR];

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

  constructor(args: {
    apiKey: string;
    runMessage: string | undefined;
    includeShareUrl: boolean;
  }) {
    this.apiKey = args.apiKey;
    this.message = args.runMessage;
    this.includeShareUrl = args.includeShareUrl;
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

    let data;
    try {
      data = await resp.json();
    } catch {
      const text = await resp.text();
      const err: HttpError = {
        status: resp.status,
        data: text,
      };
      throw new Error(JSON.stringify(err));
    }

    if (!resp.ok) {
      const err: HttpError = {
        status: resp.status,
        data,
      };
      throw new Error(JSON.stringify(err));
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

    const { id, branchId } = await this.post<{ id: string; branchId: string }>(
      '/builds',
      {
        gitProvider: ciContext.gitProvider,
        repositoryExternalId: ciContext.repoId,
        repositoryName: ciContext.repoName,
        repositoryHtmlUrl: ciContext.repoHtmlUrl,
        branchExternalId: ciContext.branchId,
        branchName: ciContext.branchName,
        isDefaultBranch: ciContext.isDefaultBranch,
        ciProvider: ciContext.ciProvider,
        buildHtmlUrl: ciContext.buildHtmlUrl,
        workflowId: ciContext.workflowId,
        workflowName: ciContext.workflowName,
        workflowRunNumber: ciContext.workflowRunNumber,
        jobName: ciContext.jobName,
        commitSha: ciContext.commitSha,
        commitMessage: ciContext.commitMessage,
        commitCommitterName: ciContext.commitCommitterName,
        commitCommitterEmail: ciContext.commitCommitterEmail,
        commitAuthorName: ciContext.commitAuthorName,
        commitAuthorEmail: ciContext.commitAuthorEmail,
        commitCommittedDate: ciContext.commitCommittedDate,
        pullRequestNumber: ciContext.pullRequestNumber,
        pullRequestTitle: ciContext.pullRequestTitle,
        autoblocksOverrides: ciContext.autoblocksOverrides,
      },
    );

    this.ciBuildId = id;
    this.ciBranchId = branchId;

    return ciContext;
  }

  getCIBranchId(): string | undefined {
    return this.ciBranchId;
  }

  getCIBuildId(): string | undefined {
    return this.ciBuildId;
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
    const shareUrl = await this.createShareUrl({
      testExternalId: args.testExternalId,
    });

    emitter.emit(EventName.RUN_ENDED, {
      id: this.currentRunId({ testExternalId: args.testExternalId }),
      testExternalId: args.testExternalId,
      shareUrl,
    });

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

  private testCaseResultIdFromHash(args: {
    testExternalId: string;
    testCaseHash: string;
  }): string {
    const testCaseResultId =
      this.testCaseHashToResultId[args.testExternalId]?.[args.testCaseHash];
    if (!testCaseResultId) {
      throw new Error(
        `No corresponding test case result ID for test case hash ${args.testCaseHash}`,
      );
    }
    return testCaseResultId;
  }

  private async createShareUrl(args: { testExternalId: string }) {
    // Share URL is only applicable for local runs
    // CI runs are always shareable
    if (this.isCI || !this.includeShareUrl) {
      return;
    }
    try {
      const runId = this.currentRunId({ testExternalId: args.testExternalId });
      const { shareUrl } = await this.post<{ shareUrl: string }>(
        `/runs/${runId}/share-url`,
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
    const debugLines: string[] = [];

    if (args.testExternalId) {
      debugLines.push(`Test ID: ${args.testExternalId}`);
      try {
        debugLines.push(
          `Run ID: ${this.currentRunId({ testExternalId: args.testExternalId })}`,
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
              testExternalId: args.testExternalId,
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
    testCaseId: string;
    testCaseHash: string;
  }) {
    const runId = this.currentRunId({
      testExternalId: args.testExternalId,
    });
    const { evaluationResults } = await this.post<{
      evaluationResults: {
        evaluatorExternalId: string;
        passed: boolean;
      }[];
    }>(`/runs/${runId}/results/${args.testCaseId}/ui-based-evaluations`);
    evaluationResults.forEach((result) => {
      const evaluation = {
        testExternalId: args.testExternalId,
        evaluatorExternalId: result.evaluatorExternalId,
        testCaseHash: args.testCaseHash,
        passed: result.passed ? EvaluationPassed.TRUE : EvaluationPassed.FALSE,
      };
      emitter.emit(EventName.EVALUATION, evaluation);
      this.evaluations.push(evaluation);
    });
  }

  async handleTestCaseResult(args: {
    testExternalId: string;
    testCaseHash: string;
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
    testCaseHumanReviewInputFields?: { name: string; value: string }[] | null;
    testCaseHumanReviewOutputFields?: { name: string; value: string }[] | null;
  }) {
    const runId = this.currentRunId({
      testExternalId: args.testExternalId,
    });

    const { id: resultId } = await this.post<{ id: string }>(
      `/runs/${runId}/results`,
      {
        testCaseHash: args.testCaseHash,
        testCaseDurationMs: args.testCaseDurationMs,
        testCaseRevisionUsage: args.testCaseRevisionUsage,
      },
    );

    if (!this.testCaseHashToResultId[args.testExternalId]) {
      this.testCaseHashToResultId[args.testExternalId] = {};
    }
    this.testCaseHashToResultId[args.testExternalId][args.testCaseHash] =
      resultId;

    const events = this.testCaseEvents
      .filter(
        (e) =>
          e.testExternalId === args.testExternalId &&
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
    revisionUsage?:
      | {
          entityExternalId: string;
          entityType: string;
          revisionId: string;
          usedAt: string;
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

    emitter.emit(EventName.EVALUATION, {
      ...args,
      passed,
    });

    const testCaseResultId = this.testCaseResultIdFromHash({
      testExternalId: args.testExternalId,
      testCaseHash: args.testCaseHash,
    });

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
      revisionUsage: args.revisionUsage,
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

    const runDurationMs = this.endTime.getTime() - this.startTime.getTime();

    const promises: Promise<void>[] = [];

    if (args.slackWebhookUrl) {
      const slackPromise = postSlackMessage({
        webhookUrl: args.slackWebhookUrl,
        buildId: this.ciBuildId,
        branchId: this.ciBranchId,
        ciContext: this.ciContext,
        runDurationMs,
        evaluations: this.evaluations,
      })
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
    }

    if (process.env.GITHUB_TOKEN) {
      const gitHubPromise = postGitHubComment({
        githubToken: process.env.GITHUB_TOKEN,
        buildId: this.ciBuildId,
        branchId: this.ciBranchId,
        ciContext: this.ciContext,
        runDurationMs,
        evaluations: this.evaluations,
      })
        .then(() => {
          emitter.emit(EventName.CONSOLE_LOG, {
            ctx: 'cli',
            level: 'info',
            message: 'Successfully posted comment to GitHub',
          });
        })
        .catch((err) => {
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
