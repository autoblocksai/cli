import { z } from 'zod';

export enum Language {
  PYTHON = 'python',
  TYPESCRIPT = 'typescript',
}

export enum AfterGradeAction {
  GRADE_NEXT = 'grade-next',
  STOP_GRADING = 'stop-grading',
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

export interface AutogeneratedEvaluator {
  id: string;
  description: string;
  filepath: string;
}

const zBinaryGrade = z.object({
  type: z.literal('binary'),
  accepted: z.boolean(),
  reason: z.string().nullish(),
});

const zGrade = z.discriminatedUnion('type', [zBinaryGrade]);

export const zTestCaseResult = z.object({
  testExternalId: z.string(),
  testCaseHash: z.string(),
  testCaseBody: z.unknown(),
  testCaseOutput: z.unknown(),
});

const zGradedTestCaseResult = zTestCaseResult.merge(
  z.object({
    grade: zGrade,
  }),
);

export type TestCaseResult = z.infer<typeof zTestCaseResult>;
export type Grade = z.infer<typeof zGrade>;
export type GradedTestCaseResult = z.infer<typeof zGradedTestCaseResult>;
