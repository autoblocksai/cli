import { z } from 'zod';

export interface TestRun {
  startedAt: string;
  endedAt: string | undefined;
  runId: string;
  testExternalId: string;
  gridSearchParamsCombo: Record<string, unknown> | undefined;
}

export enum TestRunStatus {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  NO_RESULTS = 'NO_RESULTS',
}

export enum EvaluationPassed {
  TRUE = 'TRUE',
  FALSE = 'FALSE',
  NOT_APPLICABLE = 'NOT_APPLICABLE',
}

export interface TestCaseEvent {
  testExternalId: string;
  runId: string;
  testCaseHash: string;
  event: {
    message: string;
    traceId: string;
    timestamp: string;
    properties?: unknown;
  };
}

export const zEvaluationSchema = z.object({
  testExternalId: z.string(),
  runId: z.string(),
  evaluatorExternalId: z.string(),
  testCaseHash: z.string(),
  passed: z.nativeEnum(EvaluationPassed),
  score: z.number(),
});

export type Evaluation = z.infer<typeof zEvaluationSchema>;
