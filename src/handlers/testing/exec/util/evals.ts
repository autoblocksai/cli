import { type Evaluation, TestRunStatus, EvaluationPassed } from './models';

export function makeTestRunStatusFromEvaluations(
  evals: Evaluation[],
): TestRunStatus {
  if (evals.length === 0) {
    return TestRunStatus.NO_RESULTS;
  } else if (evals.some((e) => e.passed === EvaluationPassed.FALSE)) {
    return TestRunStatus.FAILED;
  } else {
    return TestRunStatus.PASSED;
  }
}
