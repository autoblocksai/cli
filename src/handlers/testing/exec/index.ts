import { exec as execCommand } from '@actions/exec';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server/dist/types';
import { zValidator } from '@hono/zod-validator';
import crypto from 'crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { startInteractiveCLI, interactiveEmitter } from './interactive-cli';
import net from 'net';

/**
 * Utils
 */
function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    function tryListening(port: number) {
      const server = net.createServer();

      server.listen(port, () => {
        server.once('close', () => {
          resolve(port);
        });
        server.close();
      });

      server.on('error', (err) => {
        if ((err as { code?: string } | undefined)?.code === 'EADDRINUSE') {
          tryListening(port + 1);
        } else {
          reject(err);
        }
      });
    }

    tryListening(startPort);
  });
}

/**
 * Globals
 */
let _currentRunMessage: string | undefined = undefined;
let _isInteractive: boolean | undefined = undefined;

// Map of test's external ID to its current run ID and its internal test ID
const testExternalIdToRun: Record<string, { runId: string; testId: string }> =
  {};

async function currentRun(args: {
  testExternalId: string;
}): Promise<{ runId: string; testId: string }> {
  let run = testExternalIdToRun[args.testExternalId];
  if (!run) {
    run = await startRun({ testExternalId: args.testExternalId });
    testExternalIdToRun[args.testExternalId] = run;
  }
  return run;
}

/**
 * Logger
 */
const logger = {
  log: (...args: unknown[]) => {
    if (_isInteractive) {
      interactiveEmitter.emit('logging.log', args);
    } else {
      // eslint-disable-next-line no-console
      console.log(...args);
    }
  },
  warn: (...args: unknown[]) => {
    if (_isInteractive) {
      interactiveEmitter.emit('logging.warn', args);
    } else {
      // eslint-disable-next-line no-console
      console.warn(...args);
    }
  },
};

/**
 * Accumulate events for the duration of the run
 */
interface TestCaseEvent {
  testExternalId: string;
  testCaseHash: string;
  message: string;
  traceId: string;
  timestamp: string;
  properties?: unknown;
}

const testCaseEvents: TestCaseEvent[] = [];

/**
 * Keep a map of test case hashes to their result IDs
 *
 * testExternalId -> testCaseHash -> testCaseResultId
 */
const testCaseHashToResultId: Record<string, Record<string, string>> = {};

/**
 * Eval utils
 */
function evaluationPassed(args: {
  score: number;
  thresholdOp: '<' | '<=' | '>' | '>=';
  thresholdValue: number;
}): boolean {
  switch (args.thresholdOp) {
    case '<':
      return args.score < args.thresholdValue;
    case '>':
      return args.score > args.thresholdValue;
    case '<=':
      return args.score <= args.thresholdValue;
    case '>=':
      return args.score >= args.thresholdValue;
  }
}

/**
 * Public API stubs
 */
async function startRun(args: {
  testExternalId: string;
}): Promise<{ runId: string; testId: string }> {
  logger.log('POST /api/testing/local/runs', {
    testExternalId: args.testExternalId,
    message: _currentRunMessage,
  });
  return { runId: crypto.randomUUID(), testId: crypto.randomUUID() };
}

async function endRun(args: { testExternalId: string }): Promise<void> {
  const { runId } = await currentRun(args);
  logger.log(`POST /api/testing/local/runs/${runId}/end`);
  interactiveEmitter.emit('end', { testExternalId: args.testExternalId });
  delete testExternalIdToRun[args.testExternalId];
}

async function postTestCaseResult(args: {
  testExternalId: string;
  testCaseHash: string;
  testCaseBody?: unknown;
  testCaseOutput?: unknown;
  testCaseEvents: TestCaseEvent[];
}): Promise<{ testCaseResultId: string }> {
  const { runId, testId } = await currentRun(args);
  logger.log(`POST /api/testing/local/runs/${runId}/results`, {
    ...args,
    testId,
  });
  return { testCaseResultId: crypto.randomUUID() };
}

async function postTestCaseEval(args: {
  testExternalId: string;
  testCaseResultId: string;
  evaluatorId: string;
  score: number;
  passed: boolean | undefined;
  thresholdOp?: '<' | '<=' | '>' | '>=';
  thresholdValue?: number;
}): Promise<void> {
  const { runId, testId } = await currentRun(args);
  // TODO: use enums, zod schemas for passing this data to the interactive CLI
  interactiveEmitter.emit('eval', args);
  logger.log(`POST /api/testing/local/runs/${runId}/evals`, {
    ...args,
    testId,
  });
}

/**
 * Server that receives requests from the SDKs
 */
const app = new Hono();

app.post(
  '/events',
  zValidator(
    'json',
    z.object({
      testExternalId: z.string(),
      testCaseHash: z.string(),
      message: z.string(),
      traceId: z.string(),
      timestamp: z.string(),
      properties: z.unknown(),
    }),
  ),
  async (c) => {
    const data = c.req.valid('json');
    testCaseEvents.push(data);
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
      testCaseBody: z.unknown(),
      testCaseOutput: z.unknown(),
    }),
  ),
  async (c) => {
    const data = c.req.valid('json');

    const events = testCaseEvents.filter(
      (e) =>
        e.testExternalId === data.testExternalId &&
        e.testCaseHash === data.testCaseHash,
    );
    const { testCaseResultId } = await postTestCaseResult({
      ...data,
      testCaseEvents: events,
    });

    if (!testCaseHashToResultId[data.testExternalId]) {
      testCaseHashToResultId[data.testExternalId] = {};
    }

    testCaseHashToResultId[data.testExternalId][data.testCaseHash] =
      testCaseResultId;

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
      evaluatorId: z.string(),
      score: z.number(),
      thresholdOp: z.enum(['<', '<=', '>', '>=']).optional(),
      thresholdValue: z.number().optional(),
    }),
  ),
  async (c) => {
    const data = c.req.valid('json');

    let passed: boolean | undefined = undefined;
    if (data.thresholdOp && data.thresholdValue !== undefined) {
      passed = evaluationPassed({
        score: data.score,
        thresholdOp: data.thresholdOp,
        thresholdValue: data.thresholdValue,
      });
    }

    const testCaseResultId =
      testCaseHashToResultId[data.testExternalId]?.[data.testCaseHash];

    if (!testCaseResultId) {
      logger.warn(
        `No corresponding test case result ID for test case hash ${data.testCaseHash}`,
      );
      return;
    }

    await postTestCaseEval({
      ...data,
      testCaseResultId,
      passed,
    });

    return c.json({ passed });
  },
);

app.post(
  '/end',
  zValidator(
    'json',
    z.object({
      testExternalId: z.string(),
    }),
  ),
  async (c) => {
    const data = c.req.valid('json');
    await endRun(data);
    return c.json('ok');
  },
);

/**
 * Exec command while local server is running
 */
export async function exec(args: {
  command: string;
  commandArgs: string[];
  runMessage: string | undefined;
  port: number;
  interactive: boolean;
}) {
  if (args.runMessage) {
    _currentRunMessage = args.runMessage;
  }

  if (args.interactive) {
    _isInteractive = true;
    startInteractiveCLI();
  }

  let server: ServerType | undefined = undefined;

  const port = await findAvailablePort(args.port);

  server = serve(
    {
      fetch: app.fetch,
      port,
    },
    (addressInfo) => {
      const serverAddress = `http://localhost:${addressInfo.port}`;

      // Set environment variables for the SDKs to use
      const env = {
        ...process.env,
        AUTOBLOCKS_CLI_SERVER_ADDRESS: serverAddress,
      };

      // Execute the command
      execCommand(args.command, args.commandArgs, {
        env,
        silent: args.interactive,
      }).finally(async () => {
        server?.close();
      });
    },
  );
}
