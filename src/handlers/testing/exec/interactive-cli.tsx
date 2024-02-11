import { EventEmitter } from 'events';
import { Box, Text, render, useInput, Spacer } from 'ink';
import Spinner from 'ink-spinner';
import React, { useEffect, useState } from 'react';

export const interactiveEmitter = new EventEmitter();

const Space = () => <Text> </Text>;

function TestOutcomes(props: {
  runIsOver: boolean;
  testExternalId: string;
  outcomes: boolean[];
}) {
  const passed = props.outcomes.every((x) => x);
  return (
    <Box alignItems="center">
      {props.runIsOver ? (
        <Text color="white" backgroundColor={passed ? 'green' : 'red'}>
          <Space />
          {passed ? 'PASSED' : 'FAILED'}
          <Space />
        </Text>
      ) : (
        <Spinner type="dots" />
      )}
      <Space />
      <Text bold={true}>{props.testExternalId}</Text>
      <Space />
      {props.outcomes.map((passed, i) => (
        <Text key={i} color={passed ? 'green' : 'red'}>
          {'.'}
        </Text>
      ))}
      <Spacer />
      <Box borderStyle="single">
        <Text>Rerun</Text>
      </Box>
    </Box>
  );
}

const App = () => {
  const [testIdToOutcomes, setTestIdToOutcomes] = useState<
    Record<string, boolean[]>
  >({});
  const [testIdToRunIsOver, setTestIdToRunIsOver] = useState<
    Record<string, boolean>
  >({});

  useInput((input, key) => {
    // TODO: add interaction!
  });

  useEffect(() => {
    const evalListener = (args: {
      testExternalId: string;
      passed: boolean;
    }) => {
      setTestIdToOutcomes((prevOutcomes) => {
        const { testExternalId, passed } = args;
        return {
          ...prevOutcomes,
          [testExternalId]: [...(prevOutcomes[testExternalId] || []), passed],
        };
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

  return (
    <Box
      paddingX={1}
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      minHeight={12}
    >
      {Object.entries(testIdToOutcomes).map(([testId, outcomes]) => (
        <TestOutcomes
          key={testId}
          runIsOver={testIdToRunIsOver[testId]}
          testExternalId={testId}
          outcomes={outcomes}
        />
      ))}
    </Box>
  );
};

export const startInteractiveCLI = () => render(<App />);
