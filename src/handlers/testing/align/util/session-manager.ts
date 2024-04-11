import crypto from 'crypto';
import { writeEvaluatorTemplates } from './autogenerate';
import { EventName, emitter } from './emitter';
import {
  Language,
  type AutogeneratedEvaluator,
  type TestCaseEvent,
  type TestCaseResult,
  type GradedTestCaseResult,
} from './models';

export class SessionManager {
  private readonly apiKey: string;
  private readonly testExternalId: string;
  private sessionId: string | undefined;
  private language: Language | undefined = Language.PYTHON;
  private runTestSuiteCalledFromFilepath: string | undefined =
    '/Users/nicole/autoblocks/cli';
  private testCaseHashes: string[] = Array.from({ length: 10 }, () =>
    crypto.randomUUID(),
  );
  private testCaseEvents: TestCaseEvent[] = [];

  constructor(args: { apiKey: string; testExternalId: string }) {
    this.apiKey = args.apiKey;
    this.testExternalId = args.testExternalId;
  }

  async start(): Promise<void> {
    // POST /testing/local/alignment-sessions
    this.sessionId = crypto.randomUUID();
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

  async handleTestCaseResultGrade(args: GradedTestCaseResult): Promise<void> {
    if (!this.sessionId) {
      throw new Error('Session not started');
    }

    // All of the events should belong to this test case, but filter down anyway
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const events = this.testCaseEvents.filter(
      (event) => event.testCaseHash === args.testCaseHash,
    );

    // POST /testing/local/alignment-sessions/{sessionId}/grade
    // {
    //   testExternalId: args.testExternalId,
    //   testCaseHash: args.testCaseHash,
    //   testCaseBody: args.testCaseBody,
    //   testCaseOutput: args.testCaseOutput,
    //   grade: args.grade,
    //   events,
    // }
  }

  async autogenerateEvaluators(): Promise<AutogeneratedEvaluator[]> {
    if (!this.language) {
      throw new Error('Language not set');
    }
    if (!this.runTestSuiteCalledFromFilepath) {
      throw new Error('Test suite directory not set');
    }

    // GET /testing/local/alignment-sessions/{sessionId}/evaluators
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const evaluators: Omit<AutogeneratedEvaluator, 'filepath'>[] = [
      {
        id: 'has-substrings',
        description:
          'Check if the output has the expected substrings from the test case',
      },
      {
        id: 'is-professional-tone',
        description:
          'Use an LLM to detect if the tone of the output is professional',
      },
    ];

    return writeEvaluatorTemplates({
      language: this.language,
      runTestSuiteCalledFromFilepath: this.runTestSuiteCalledFromFilepath,
      evaluators,
    });
  }
}
