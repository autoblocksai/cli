import { z } from 'zod';
import { EventEmitter } from 'events';

// Enum for event names
export enum EventName {
  EVALUATION = 'EVALUATION',
  RUN_ENDED = 'RUN_ENDED',
}

// Zod schemas for event data
const zEvaluationSchema = z.object({
  testExternalId: z.string(),
  evaluatorExternalId: z.string(),
  testCaseHash: z.string(),
  passed: z.boolean().nullable(),
});

const zRunEndedSchema = z.object({
  testExternalId: z.string(),
});

const eventSchemas = {
  [EventName.EVALUATION]: zEvaluationSchema,
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
