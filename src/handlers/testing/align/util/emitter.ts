import { EventEmitter } from 'events';
import { z } from 'zod';
import type { HandlerOf } from '../../../../util/types';
import { zTestCaseResult } from './models';

export enum EventName {
  TEST_CASE_RESULT = 'TEST_CASE_RESULT',
}

const eventSchemas = {
  [EventName.TEST_CASE_RESULT]: zTestCaseResult,
};

export type EventSchemas = {
  [K in EventName]: z.infer<(typeof eventSchemas)[K]>;
};

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
