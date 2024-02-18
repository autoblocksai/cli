import { Box, Spacer, Static, Text, render } from 'ink';
import Link from 'ink-link';
import Spinner from 'ink-spinner';
import { useEffect, useState } from 'react';
import { EventName, emitter, type EventSchemas } from '../../emitter';

type ConsoleLog = EventSchemas[EventName.CONSOLE_LOG];
type UncaughtError = EventSchemas[EventName.UNCAUGHT_ERROR];
type Evaluation = EventSchemas[EventName.EVALUATION];
type RunEnded = EventSchemas[EventName.RUN_ENDED];

const MAX_TEST_CASES = 100;

/**
 * Uses add() to ensure that the set is ordered by insertion order
 *
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set
 */
function makeOrdereredSet(vals: string[]): Set<string> {
  const set = new Set<string>();
  vals.forEach((val) => set.add(val));
  return set;
}

const Space = () => <Text> </Text>;

function colorFromPassed(passed: boolean | null | undefined): string {
  switch (passed) {
    case true:
      return 'green';
    case false:
      return 'red';
    case null:
      return 'yellow';
    case undefined:
      return 'gray';
    default:
      return 'gray';
  }
}

function colorFromLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): string {
  switch (level) {
    case 'debug':
      return 'cyan';
    case 'info':
      return 'white';
    case 'warn':
      return 'yellow';
    case 'error':
      return 'red';
    default:
      return 'gray';
  }
}

function TestRow(props: {
  runIsOver: boolean;
  testExternalId: string;
  evals: Evaluation[];
  errors: UncaughtError[];
}) {
  const uniqEvaluatorExternalIds = makeOrdereredSet(
    props.evals.map((e) => e.evaluatorExternalId),
  );
  const uniqTestCaseHashes = makeOrdereredSet(
    props.evals.map((e) => e.testCaseHash),
  );

  const testDidPassOverall =
    props.evals.every((e) => e.passed !== false) && props.errors.length === 0;
  return (
    <Box flexDirection="column">
      <Box>
        {props.runIsOver ? (
          <Text color={testDidPassOverall ? 'green' : 'red'}>
            {testDidPassOverall ? '✓' : '✗'}
          </Text>
        ) : (
          <Spinner type="dots" />
        )}
        <Space />
        <Text bold={true}>{props.testExternalId}</Text>
        <Spacer />
        <Link
          url={`https://app.autoblocks.ai/testing/local/tests/${encodeURIComponent(props.testExternalId)}`}
        >
          View
        </Link>
      </Box>
      <Box paddingLeft={2} columnGap={2}>
        <Box flexDirection="column">
          {Array.from(uniqEvaluatorExternalIds).map((evaluatorExternalId) => {
            return (
              <Box key={evaluatorExternalId} columnGap={1}>
                <Text color="gray">{evaluatorExternalId}</Text>
              </Box>
            );
          })}
        </Box>
        <Box flexDirection="column">
          {Array.from(uniqEvaluatorExternalIds).map((evaluatorExternalId) => {
            return (
              <Box key={evaluatorExternalId} overflowX="hidden">
                {Array.from(uniqTestCaseHashes)
                  .slice(-1 * MAX_TEST_CASES)
                  .map((testCaseHash) => {
                    const passed = props.evals.find(
                      (e) =>
                        e.evaluatorExternalId === evaluatorExternalId &&
                        e.testCaseHash === testCaseHash,
                    )?.passed;
                    const hasUncaughtError = props.errors.some(
                      (e) =>
                        e.testCaseHash === testCaseHash &&
                        (e.evaluatorExternalId === evaluatorExternalId ||
                          e.evaluatorExternalId === undefined),
                    );
                    return (
                      <Text
                        key={testCaseHash}
                        color={
                          hasUncaughtError ? 'white' : colorFromPassed(passed)
                        }
                      >
                        {'.'}
                      </Text>
                    );
                  })}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

const App = () => {
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([]);
  const [uncaughtErrors, setUncaughtErrors] = useState<UncaughtError[]>([]);
  const [evals, setEvals] = useState<Evaluation[]>([]);
  const [testIdToRunIsOver, setTestIdToRunIsOver] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    const consoleLogListener = (log: ConsoleLog) => {
      setConsoleLogs((prevLogs) => {
        return [...prevLogs, log];
      });
    };

    const uncaughtErrorListener = (error: UncaughtError) => {
      setUncaughtErrors((prevErrors) => {
        return [...prevErrors, error];
      });
    };

    const evalListener = (evaluation: Evaluation) => {
      setEvals((prevEvals) => {
        return [...prevEvals, evaluation];
      });
    };

    const runEndListener = (runEnded: RunEnded) => {
      setTestIdToRunIsOver((prevRunIsOver) => {
        return { ...prevRunIsOver, [runEnded.testExternalId]: true };
      });
    };

    emitter.on(EventName.CONSOLE_LOG, consoleLogListener);
    emitter.on(EventName.UNCAUGHT_ERROR, uncaughtErrorListener);
    emitter.on(EventName.EVALUATION, evalListener);
    emitter.on(EventName.RUN_ENDED, runEndListener);

    return () => {
      emitter.off(EventName.CONSOLE_LOG, consoleLogListener);
      emitter.off(EventName.UNCAUGHT_ERROR, uncaughtErrorListener);
      emitter.off(EventName.EVALUATION, evalListener);
      emitter.off(EventName.RUN_ENDED, runEndListener);
    };
  }, []);

  const uniqTestExternalIds = makeOrdereredSet(
    evals.map((e) => e.testExternalId),
  );

  return (
    <>
      <Static items={consoleLogs}>
        {(log, idx) => (
          <Box key={`${idx}`} flexDirection="column">
            <Text>
              <Text color="gray">
                {'['}
                {log.ctx}
                {']'}
              </Text>
              <Text color={colorFromLogLevel(log.level)} bold={true}>
                {'['}
                {log.level.toUpperCase()}
                {']'}
              </Text>
              <Space />
              {log.message}
            </Text>
          </Box>
        )}
      </Static>
      <Box
        paddingX={1}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        minHeight={12}
      >
        {Array.from(uniqTestExternalIds).map((testExternalId) => {
          const testEvals = evals.filter(
            (e) => e.testExternalId === testExternalId,
          );
          const errors = uncaughtErrors.filter(
            (e) => e.testExternalId === testExternalId,
          );
          return (
            <TestRow
              key={testExternalId}
              runIsOver={testIdToRunIsOver[testExternalId]}
              testExternalId={testExternalId}
              evals={testEvals}
              errors={errors}
            />
          );
        })}
      </Box>
    </>
  );
};

export const renderTestProgress = () => render(<App />);
