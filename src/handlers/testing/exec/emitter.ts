import { EventEmitter } from 'events';
import { z } from 'zod';

// Enum for event names
export enum EventName {
  CONSOLE_LOG = 'CONSOLE_LOG',
  UNCAUGHT_ERROR = 'UNCAUGHT_ERROR',
  EVALUATION = 'EVALUATION',
  RUN_STARTED = 'RUN_STARTED',
  RUN_ENDED = 'RUN_ENDED',
}

// Zod schemas for event data
const zConsoleLogSchema = z.object({
  ctx: z.enum(['cmd', 'cli']),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
});

const zUncaughtErrorSchema = z.object({
  testExternalId: z.string(),
  // Will be defined if the error occurred within a certain test case
  testCaseHash: z.string().optional(),
  // Will be defined if the error occurred within a certain evaluator
  evaluatorExternalId: z.string().optional(),
  error: z.object({
    name: z.string(),
    message: z.string(),
    stacktrace: z.string(),
  }),
});

const zEvaluationSchema = z.object({
  testExternalId: z.string(),
  evaluatorExternalId: z.string(),
  testCaseHash: z.string(),
  passed: z.boolean().nullable(),
});

const zRunStartedSchema = z.object({
  testExternalId: z.string(),
});

const zRunEndedSchema = z.object({
  testExternalId: z.string(),
});

const eventSchemas = {
  [EventName.CONSOLE_LOG]: zConsoleLogSchema,
  [EventName.UNCAUGHT_ERROR]: zUncaughtErrorSchema,
  [EventName.EVALUATION]: zEvaluationSchema,
  [EventName.RUN_STARTED]: zRunStartedSchema,
  [EventName.RUN_ENDED]: zRunEndedSchema,
};

export type EventSchemas = {
  [K in EventName]: z.infer<(typeof eventSchemas)[K]>;
};

type HandlerOf<T> = (val: T) => void;

class TypedEventEmitter {
  private readonly emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
  }

  on<K extends keyof EventSchemas>(
    eventName: K,
    listener: HandlerOf<EventSchemas[K]>,
  ): void {
    this.emitter.on(eventName, listener);
  }

  off<K extends keyof EventSchemas>(
    eventName: K,
    listener: HandlerOf<EventSchemas[K]>,
  ): void {
    this.emitter.off(eventName, listener);
  }

  emit<K extends keyof EventSchemas>(
    eventName: K,
    data: EventSchemas[K],
  ): void {
    const schema = eventSchemas[eventName];
    const parsed = schema.parse(data);
    this.emitter.emit(eventName, parsed);
  }
}

export const emitter = new TypedEventEmitter();
