import { EventEmitter } from 'events';
import { Box, Text, render, useInput, Spacer } from 'ink';
import Spinner from 'ink-spinner';
import React, { useEffect, useState } from 'react';
import Link from 'ink-link';

interface Evaluation {
  testExternalId: string;
  evaluatorExternalId: string;
  testCaseHash: string;
  passed: boolean | undefined;
}

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

export const interactiveEmitter = new EventEmitter();

const Space = () => <Text> </Text>;

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
      <Box alignItems="center" paddingLeft={2}>
        <Box flexDirection="column" paddingRight={1}>
          {Array.from(uniqEvaluatorExternalIds).map((evaluatorExternalId) => {
            return (
              <Text key={evaluatorExternalId} color="gray">
                {evaluatorExternalId}
              </Text>
            );
          })}
        </Box>
        <Box flexDirection="column">
          {Array.from(uniqEvaluatorExternalIds).map((evaluatorExternalId) => {
            return (
              <Box key={evaluatorExternalId}>
                {Array.from(uniqTestCaseHashes).map((testCaseHash) => {
                  const passed = props.evals.find(
                    (e) =>
                      e.evaluatorExternalId === evaluatorExternalId &&
                      e.testCaseHash === testCaseHash,
                  )?.passed;
                  return (
                    <Text
                      key={testCaseHash}
                      color={
                        passed == undefined ? 'gray' : passed ? 'green' : 'red'
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
  const [evals, setEvals] = useState<Evaluation[]>([]);
  const [testIdToRunIsOver, setTestIdToRunIsOver] = useState<
    Record<string, boolean>
  >({});

  useInput((input, key) => {
    // TODO: add interaction!
  });

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

    interactiveEmitter.on('eval', evalListener);
    interactiveEmitter.on('end', onEndListener);

    return () => {
      interactiveEmitter.off('eval', evalListener);
      interactiveEmitter.off('end', onEndListener);
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
