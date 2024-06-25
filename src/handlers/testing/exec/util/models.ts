import { z } from 'zod';

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
});

export type Evaluation = z.infer<typeof zEvaluationSchema>;
