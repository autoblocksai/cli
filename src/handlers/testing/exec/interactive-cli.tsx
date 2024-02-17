import { Box, Text, render, Spacer } from 'ink';
import Spinner from 'ink-spinner';
import React, { useEffect, useState } from 'react';
import Link from 'ink-link';
import { emitter, EventName, type EventSchemas } from './emitter';

type Evaluation = EventSchemas[EventName.EVALUATION];

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

function TestRow(props: {
  runIsOver: boolean;
  testExternalId: string;
  evals: Evaluation[];
}) {
  const uniqEvaluatorExternalIds = makeOrdereredSet(
    props.evals.map((e) => e.evaluatorExternalId),
  );
  const uniqTestCaseHashes = makeOrdereredSet(
    props.evals.map((e) => e.testCaseHash),
  );

  const testDidPassOverall = props.evals.every((e) => e.passed !== false);
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
                  .slice(-100)
                  .map((testCaseHash) => {
                    const passed = props.evals.find(
                      (e) =>
                        e.evaluatorExternalId === evaluatorExternalId &&
                        e.testCaseHash === testCaseHash,
                    )?.passed;
                    return (
                      <Text key={testCaseHash} color={colorFromPassed(passed)}>
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
  const [evals, setEvals] = useState<Evaluation[]>([]);
  const [testIdToRunIsOver, setTestIdToRunIsOver] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    const evalListener = (e: Evaluation) => {
      setEvals((prevEvals) => {
        return [...prevEvals, e];
      });
    };

    const onEndListener = (args: { testExternalId: string }) => {
      setTestIdToRunIsOver((prevRunIsOver) => {
        return { ...prevRunIsOver, [args.testExternalId]: true };
      });
    };

    emitter.on(EventName.EVALUATION, evalListener);
    emitter.on(EventName.RUN_ENDED, onEndListener);

    return () => {
      emitter.off(EventName.EVALUATION, evalListener);
      emitter.off(EventName.RUN_ENDED, onEndListener);
    };
  }, []);

  const uniqTestExternalIds = makeOrdereredSet(
    evals.map((e) => e.testExternalId),
  );

  return (
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
        return (
          <TestRow
            key={testExternalId}
            runIsOver={testIdToRunIsOver[testExternalId]}
            testExternalId={testExternalId}
            evals={testEvals}
          />
        );
      })}
    </Box>
  );
};

export const startInteractiveCLI = () => render(<App />);
