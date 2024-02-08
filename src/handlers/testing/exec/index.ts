import { exec as execCommand } from '@actions/exec';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server/dist/types';
import { zValidator } from '@hono/zod-validator';
import crypto from 'crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { startInteractiveCLI, interactiveEmitter } from './interactive-cli';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Current run utils
 */
let _currentRunId: string | undefined = undefined;
let _currentRunMessage: string | undefined = undefined;

async function currentRunId(): Promise<string> {
  if (!_currentRunId) {
    const run = await startRun();
    _currentRunId = run.runId;
  }
  return _currentRunId;
}

/**
 * Accumulate events for the duration of the run
 */
interface TestCaseEvent {
  testId: string;
  testCaseHash: string;
  message: string;
  traceId: string;
  timestamp: string;
  properties?: unknown;
}

const testCaseEvents: TestCaseEvent[] = [];

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
async function startRun(): Promise<{ runId: string }> {
  console.log('POST /api/testing/local/runs', { message: _currentRunMessage });
  return { runId: crypto.randomUUID() };
}

async function endRun(): Promise<void> {
  const runId = await currentRunId();
  console.log(`POST /api/testing/local/runs/${runId}/end`);
  interactiveEmitter.emit('end');
  _currentRunId = undefined;
}

async function postTestCaseResult(args: {
  testId: string;
  testCaseHash: string;
  testCaseBody?: unknown;
  testCaseOutput?: unknown;
  testCaseEvents: TestCaseEvent[];
}): Promise<void> {
  const runId = await currentRunId();
  console.log(`POST /api/testing/local/runs/${runId}/results`, args);
}

async function postTestCaseEval(args: {
  testId: string;
  testCaseHash: string;
  evaluatorId: string;
  score: number;
  passed: boolean | undefined;
  thresholdOp?: '<' | '<=' | '>' | '>=';
  thresholdValue?: number;
}): Promise<void> {
  const runId = await currentRunId();
  await sleep(1000);
  // TODO: use enums, zod schemas for passing this data to the interactive CLI
  interactiveEmitter.emit('eval', { ...args, runId });
  console.log(`POST /api/testing/local/runs/${runId}/evals`, args);
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
      testId: z.string(),
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
      testId: z.string(),
      testCaseHash: z.string(),
      testCaseBody: z.unknown(),
      testCaseOutput: z.unknown(),
    }),
  ),
  async (c) => {
    const data = c.req.valid('json');
    const events = testCaseEvents.filter(
      (e) => e.testId === data.testId && e.testCaseHash === data.testCaseHash,
    );
    await postTestCaseResult({
      ...data,
      testCaseEvents: events,
    });

    return c.json('ok');
  },
);

app.post(
  '/evals',
  zValidator(
    'json',
    z.object({
      testId: z.string(),
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

    await postTestCaseEval({
      ...data,
      passed,
    });

    return c.json({ passed });
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
    startInteractiveCLI();
  }

  let server: ServerType | undefined = undefined;

  server = serve(
    {
      fetch: app.fetch,
      port: args.port,
    },
    () => {
      const serverAddress = `http://localhost:${args.port}`;

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
        await endRun();
        server?.close();
      });
    },
  );
}
