import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';
import { type ZodError, z } from 'zod';
import { Language } from './models';
import { SessionManager } from './session-manager';

const handleValidationResult = (
  result: { success: boolean; error?: ZodError<unknown> },
  c: Context,
) => {
  if (!result.success) {
    return c.json('Bad Request', 400);
  }
};

/**
 * Server that receives requests from the SDKs
 */
export function createHonoApp(sessionManager: SessionManager): Hono {
  const app = new Hono();

  app.post(
    '/info',
    zValidator(
      'json',
      z.object({
        language: z.nativeEnum(Language),
        runTestSuiteCalledFromDirectory: z.string(),
        testCaseHashes: z.array(z.string()),
      }),
      handleValidationResult,
    ),
    (c) => {
      const data = c.req.valid('json');
      sessionManager.handleInfo(data);
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
      sessionManager.handleTestCaseEvent(data);
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
      }),
      handleValidationResult,
    ),
    (c) => {
      const data = c.req.valid('json');
      sessionManager.handleTestCaseResult(data);
      return c.json('ok');
    },
  );

  // Add a catch-all route to return a 200 OK for any other requests
  // since the testing SDKs will make other requests that we don't
  // need to handle when in alignment mode
  app.post('*', (c) => {
    return c.json('ok');
  });

  return app;
}
