import { z } from 'zod';
import { AUTOBLOCKS_API_BASE_URL } from '../../../../util/constants';
import { writeEvaluatorTemplates } from './autogenerate';
import { EventName, emitter } from './emitter';
import {
  Language,
  zAutogeneratedEvaluator,
  type AutogeneratedEvaluatorWithFilepath,
  type GradedTestCaseResult,
  type TestCaseEvent,
  type TestCaseResult,
} from './models';

export class SessionManager {
  private readonly apiKey: string;
  private readonly testExternalId: string;
  private sessionId: string | undefined;
  private language: Language | undefined;
  private runTestSuiteCalledFromFilepath: string | undefined;
  private testCaseHashes: string[] = [];
  private testCaseEvents: TestCaseEvent[] = [];

  constructor(args: { apiKey: string; testExternalId: string }) {
    this.apiKey = args.apiKey;
    this.testExternalId = args.testExternalId;
  }

  private async request<T>(args: {
    method: 'POST' | 'GET';
    path: string;
    body?: unknown;
  }): Promise<T> {
    const resp = await fetch(
      `${AUTOBLOCKS_API_BASE_URL}/testing/local/alignment-sessions${args.path}`,
      {
        method: args.method,
        body: args.body ? JSON.stringify(args.body) : undefined,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
      },
    );
    const data = await resp.json();
    if (!resp.ok) {
      // Our API returns errors formated at JSON, so just throw
      // the stringified JSON
      throw new Error(JSON.stringify(data));
    }
    return data;
  }

  async start(): Promise<void> {
    const { id: sessionId } = await this.request<{ id: string }>({
      method: 'POST',
      path: '',
      body: {
        testExternalId: this.testExternalId,
      },
    });
    this.sessionId = sessionId;
  }

  handleInfo(args: {
    language: Language;
    runTestSuiteCalledFromFilepath: string;
    testCaseHashes: string[];
  }) {
    this.language = args.language;
    this.runTestSuiteCalledFromFilepath = args.runTestSuiteCalledFromFilepath;
    this.testCaseHashes = args.testCaseHashes;
  }

  getSessionId(): string {
    if (!this.sessionId) {
      throw new Error('Session not started');
    }
    return this.sessionId;
  }

  getTestCaseHashes(): string[] {
    return this.testCaseHashes;
  }

  nextTestCaseHash(prevHash: string): string | undefined {
    const idx = this.testCaseHashes.indexOf(prevHash);
    if (idx !== -1 && idx < this.testCaseHashes.length - 1) {
      return this.testCaseHashes[idx + 1];
    }
    return undefined;
  }

  handleTestCaseEvent(event: TestCaseEvent) {
    if (event.testExternalId !== this.testExternalId) {
      throw new Error('Test external ID does not match');
    }

    this.testCaseEvents.push(event);
  }

  resetTestCaseEvents() {
    this.testCaseEvents = [];
  }

  handleTestCaseResult(result: TestCaseResult): void {
    if (result.testExternalId !== this.testExternalId) {
      throw new Error('Test external ID does not match');
    }

    emitter.emit(EventName.TEST_CASE_RESULT, result);
  }

  async handleGradedTestCaseResult(
    gradedResult: GradedTestCaseResult,
  ): Promise<void> {
    if (!this.sessionId) {
      throw new Error('Session not started');
    }

    // All of the events should belong to this test and test case, but filter down anyway
    const events = this.testCaseEvents
      .filter(
        (event) =>
          event.testExternalId === this.testExternalId &&
          event.testCaseHash === gradedResult.testCaseHash,
      )
      .map((e) => e.event);

    await this.request({
      method: 'POST',
      path: `/${this.sessionId}/graded-test-case-results`,
      body: {
        testCaseHash: gradedResult.testCaseHash,
        testCaseBody: gradedResult.testCaseBody,
        testCaseOutput: gradedResult.testCaseOutput,
        testCaseEvents: events,
        grade: gradedResult.grade,
      },
    });
  }

  async autogenerateEvaluators(): Promise<
    AutogeneratedEvaluatorWithFilepath[]
  > {
    if (!this.sessionId) {
      throw new Error('Session not started');
    }
    if (!this.language) {
      throw new Error('Language not set');
    }
    if (!this.runTestSuiteCalledFromFilepath) {
      throw new Error('Test suite directory not set');
    }

    const resp = await this.request({
      method: 'GET',
      path: `/${this.sessionId}/gen-evaluators`,
    });
    const evaluators = z.array(zAutogeneratedEvaluator).parse(resp);

    return writeEvaluatorTemplates({
      language: this.language,
      runTestSuiteCalledFromFilepath: this.runTestSuiteCalledFromFilepath,
      evaluators,
    });
  }
}
