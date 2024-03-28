import { type Evaluation, TestRunStatus } from './models';

export function testRunStatusFromEvaluations(
  evals: Evaluation[],
): TestRunStatus {
  if (evals.length === 0) {
    return TestRunStatus.NO_RESULTS;
  } else if (evals.some((e) => e.passed === false)) {
    return TestRunStatus.FAILED;
  } else {
    return TestRunStatus.PASSED;
  }
}
