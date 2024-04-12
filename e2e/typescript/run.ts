import {
  BaseTestEvaluator,
  runTestSuite,
  type Evaluation,
} from '@autoblocks/client/testing';
import * as crypto from 'crypto';

interface MyTestCase {
  input: string;
  expectedSubstrings: string[];
}

async function testFn({ testCase }: { testCase: MyTestCase }): Promise<string> {
  // Simulate doing work
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 1000));

  const substrings = testCase.input.split('-');
  if (Math.random() < 0.2) {
    // Remove a substring randomly. This will cause about 20% of the test cases to fail
    // the "has-all-substrings" evaluator.
    substrings.pop();
  }

  return substrings.join('-');
}

class HasAllSubstrings extends BaseTestEvaluator<MyTestCase, string> {
  id = 'has-all-substrings';

  evaluateTestCase(args: { testCase: MyTestCase; output: string }): Evaluation {
    const score = args.testCase.expectedSubstrings.every((s) =>
      args.output.includes(s),
    )
      ? 1
      : 0;

    return {
      score,
      threshold: {
        gte: 1,
      },
    };
  }
}

class IsFriendly extends BaseTestEvaluator<MyTestCase, string> {
  id = 'is-friendly';

  async getScore(output: string): Promise<number> {
    // eslint-disable-next-line no-console
    console.log(`Determining score for output: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 1000));
    return Math.random();
  }

  async evaluateTestCase(args: {
    testCase: MyTestCase;
    output: string;
  }): Promise<Evaluation> {
    const score = await this.getScore(args.output);

    return {
      score,
    };
  }
}

function genTestCases(n: number): MyTestCase[] {
  const testCases: MyTestCase[] = [];
  for (let i = 0; i < n; i++) {
    const randomId = crypto.randomUUID();
    testCases.push({
      input: randomId,
      expectedSubstrings: randomId.split('-'),
    });
  }
  return testCases;
}

(async () => {
  await runTestSuite<MyTestCase, string>({
    id: 'my-test-suite',
    fn: testFn,
    testCaseHash: ['input'],
    testCases: genTestCases(4),
    evaluators: [new HasAllSubstrings(), new IsFriendly()],
  });
})();
