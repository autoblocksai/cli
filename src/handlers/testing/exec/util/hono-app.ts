import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';
import { type ZodError, z } from 'zod';
import { EventName, emitter } from './emitter';
import { RunManager } from './run-manager';

/**
 * Server that receives requests from the SDKs
 */
export function createHonoApp(runManager: RunManager): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    runManager.handleUncaughtError({
      error: {
        name: 'HTTPError',
        message: `${c.req.method} ${c.req.path}`,
        stacktrace: err.stack ?? err.message,
      },
      ctx: 'cli',
    });
    return c.json('Internal Server Error', 500);
  });

  const handleValidationResult = (
    result: { success: boolean; error?: ZodError<unknown> },
    c: Context,
  ) => {
    if (!result.success) {
      emitter.emit(EventName.CONSOLE_LOG, {
        ctx: 'cli',
        level: 'error',
        message: `${c.req.method} ${c.req.path}: ${result.error}`,
      });
      return c.json('Bad Request', 400);
    }
  };

  app.get('/', (c) => {
    return c.text('👋');
  });

  app.post(
    '/start',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
      }),
      handleValidationResult,
    ),
    async (c) => {
      const data = c.req.valid('json');
      await runManager.handleStartRun(data);
      return c.json('ok');
    },
  );

  app.post(
    '/end',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
      }),
      handleValidationResult,
    ),
    async (c) => {
      const data = c.req.valid('json');
      await runManager.handleEndRun(data);
      return c.json('ok');
    },
  );

  app.post(
    '/events',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
        testCaseHash: z.string(),
        event: z.object({
          message: z.string(),
          traceId: z.string(),
          timestamp: z.string().datetime({ offset: true }),
          properties: z.unknown(),
        }),
      }),
      handleValidationResult,
    ),
    async (c) => {
      const data = c.req.valid('json');
      runManager.handleTestCaseEvent(data);
      return c.json('ok');
    },
  );

  app.post(
    '/errors',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
        testCaseHash: z
          .string()
          .nullish()
          .transform((x) => x ?? undefined),
        evaluatorExternalId: z
          .string()
          .nullish()
          .transform((x) => x ?? undefined),
        error: z.object({
          name: z.string(),
          message: z.string(),
          stacktrace: z.string(),
        }),
      }),
      handleValidationResult,
    ),
    async (c) => {
      const data = c.req.valid('json');
      runManager.handleUncaughtError({
        ...data,
        ctx: 'cmd',
      });
      return c.json('ok');
    },
  );

  app.post(
    '/results',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
        testCaseHash: z.string(),
        testCaseBody: z.record(z.string(), z.unknown()),
        testCaseOutput: z.unknown(),
        testCaseDurationMs: z.number().min(0).nullish(),
        testCaseRevisionUsage: z
          .array(
            z.object({
              entityExternalId: z.string(),
              entityType: z.enum(['prompt', 'config']),
              revisionId: z.string().cuid2(),
              usedAt: z.string().datetime({ offset: true }),
            }),
          )
          .nullish(),
        testCaseHumanReviewInputFields: z
          .array(
            z.object({
              name: z.string(),
              value: z.string(),
            }),
          )
          .nullish(),
        testCaseHumanReviewOutputFields: z
          .array(
            z.object({
              name: z.string(),
              value: z.string(),
            }),
          )
          .nullish(),
      }),
      handleValidationResult,
    ),
    async (c) => {
      const data = c.req.valid('json');
      await runManager.handleTestCaseResult(data);
      return c.json('ok');
    },
  );

  app.post(
    '/evals',
    zValidator(
      'json',
      z.object({
        testExternalId: z.string(),
        testCaseHash: z.string(),
        evaluatorExternalId: z.string(),
        score: z.number(),
        threshold: z
          .object({
            lt: z
              .number()
              .nullish()
              .transform((x) => x ?? undefined),
            lte: z
              .number()
              .nullish()
              .transform((x) => x ?? undefined),
            gt: z
              .number()
              .nullish()
              .transform((x) => x ?? undefined),
            gte: z
              .number()
              .nullish()
              .transform((x) => x ?? undefined),
          })
          .nullish()
          .transform((x) => x ?? undefined),
        metadata: z
          .unknown()
          .nullish()
          .transform((x) => x ?? undefined),
        revisionUsage: z
          .array(
            z.object({
              entityExternalId: z.string(),
              entityType: z.enum(['prompt', 'config']),
              revisionId: z.string().cuid2(),
              usedAt: z.string().datetime({ offset: true }),
            }),
          )
          .nullish(),
      }),
      handleValidationResult,
    ),
    async (c) => {
      const data = c.req.valid('json');
      await runManager.handleTestCaseEval(data);
      return c.json('ok');
    },
  );

  return app;
}
