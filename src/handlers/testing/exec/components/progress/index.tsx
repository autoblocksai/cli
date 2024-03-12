import { Box, Static, Text, render } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useState } from 'react';
import { EventName, emitter, type EventSchemas } from '../../emitter';

type ConsoleLog = EventSchemas[EventName.CONSOLE_LOG];
type UncaughtError = EventSchemas[EventName.UNCAUGHT_ERROR];
type Evaluation = EventSchemas[EventName.EVALUATION];
type RunStarted = EventSchemas[EventName.RUN_STARTED];
type RunEnded = EventSchemas[EventName.RUN_ENDED];

const MAX_TEST_CASES = 100;

/**
 * Uses add() to ensure that the list is ordered by insertion order
 *
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set
 */
function uniq(vals: string[]): string[] {
  const set = new Set<string>();
  vals.forEach((val) => set.add(val));
  return Array.from(set);
}

function makeTestStatus(evals: Evaluation[]): 'pass' | 'fail' | 'no-results' {
  if (evals.length === 0) {
    return 'no-results';
  } else if (evals.some((e) => e.passed === false)) {
    return 'fail';
  } else {
    return 'pass';
  }
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
  const uniqEvaluatorExternalIds = uniq(
    props.evals.map((e) => e.evaluatorExternalId),
  );
  const uniqTestCaseHashes = uniq(props.evals.map((e) => e.testCaseHash));

  const testStatus = makeTestStatus(props.evals);
  const testStatusColor = {
    pass: 'green',
    fail: 'red',
    'no-results': 'gray',
  }[testStatus];
  const testStatusIcon = {
    pass: '✓',
    fail: '✗',
    'no-results': '?',
  }[testStatus];

  return (
    <Box flexDirection="column">
      <Box columnGap={1}>
        {props.runIsOver ? (
          <Text color={testStatusColor}>{testStatusIcon}</Text>
        ) : (
          <Spinner type="dots" />
        )}
        <Text bold={true}>{props.testExternalId}</Text>
      </Box>
      <Box paddingLeft={2} columnGap={2}>
        {props.runIsOver && testStatus === 'no-results' && (
          <Text color="gray">No results.</Text>
        )}
        <Box flexDirection="column">
          {uniqEvaluatorExternalIds.map((evaluatorExternalId) => {
            return (
              <Box key={evaluatorExternalId} columnGap={1}>
                <Text color="gray">{evaluatorExternalId}</Text>
              </Box>
            );
          })}
        </Box>
        <Box flexDirection="column">
          {uniqEvaluatorExternalIds.map((evaluatorExternalId) => {
            return (
              <Box key={evaluatorExternalId} overflowX="hidden">
                {uniqTestCaseHashes
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

const App = (props: { onListenersCreated: () => void }) => {
  const [testExternalIds, setTestExternalIds] = useState<string[]>([]);
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

    const runStartListener = (runStarted: RunStarted) => {
      setTestExternalIds((prevIds) => {
        return [
          ...prevIds.filter((id) => id !== runStarted.testExternalId),
          runStarted.testExternalId,
        ];
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
    emitter.on(EventName.RUN_STARTED, runStartListener);
    emitter.on(EventName.RUN_ENDED, runEndListener);

    props.onListenersCreated();

    return () => {
      emitter.off(EventName.CONSOLE_LOG, consoleLogListener);
      emitter.off(EventName.UNCAUGHT_ERROR, uncaughtErrorListener);
      emitter.off(EventName.EVALUATION, evalListener);
      emitter.off(EventName.RUN_STARTED, runStartListener);
      emitter.off(EventName.RUN_ENDED, runEndListener);
    };
  }, []);

  return (
    <>
      <Static items={consoleLogs}>
        {(log, idx) => (
          <Box key={idx}>
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
        // NOTE: This margin is required to prevent the logs being shown in the <Static> component
        // above from clobbering this box
        marginTop={1}
        paddingX={1}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        minHeight={12}
        rowGap={1}
      >
        {testExternalIds.length === 0 && (
          <Box>
            <Text color="gray">
              Waiting for test results
              <Spinner type="simpleDots" />
            </Text>
          </Box>
        )}
        {testExternalIds.map((testExternalId) => {
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

export const renderTestProgress = (args: { onListenersCreated: () => void }) =>
  render(<App onListenersCreated={args.onListenersCreated} />);
