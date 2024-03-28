import { z } from 'zod';

export enum TestRunStatus {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  NO_RESULTS = 'NO_RESULTS',
}

export interface TestCaseEvent {
  testExternalId: string;
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
  evaluatorExternalId: z.string(),
  testCaseHash: z.string(),
  passed: z.boolean().nullable(),
});

export type Evaluation = z.infer<typeof zEvaluationSchema>;
