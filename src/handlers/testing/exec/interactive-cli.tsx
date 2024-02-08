import { EventEmitter } from 'events';
import { Box, Text, render, useInput, Spacer } from 'ink';
import Spinner from 'ink-spinner';
import React, { useEffect, useState } from 'react';

export const interactiveEmitter = new EventEmitter();

const Space = () => <Text> </Text>;

const App = () => {
  const [outcomes, setOutcomes] = useState<boolean[]>([]);
  const [runIsOver, setRunIsOver] = useState<boolean>(false);

  useInput((input, key) => {
    // TODO: add interaction!
  });

  useEffect(() => {
    const evalListener = (args: { passed: boolean }) => {
      setOutcomes((prevOutcomes) => [...prevOutcomes, args.passed]);
    };

    const onEndListener = () => {
      setRunIsOver(true);
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
      borderStyle="round"
      borderColor="gray"
      alignItems="center"
    >
      {runIsOver ? (
        <Text
          color="white"
          backgroundColor={outcomes.every((x) => x) ? 'green' : 'red'}
        >
          <Space />
          {outcomes.every((x) => x) ? 'PASSED' : 'FAILED'}
          <Space />
        </Text>
      ) : (
        <Spinner type="dots" />
      )}
      <Space />
      <Text bold={true}>acme-bot</Text>
      <Space />
      {outcomes.map((passed, i) => (
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
};

export const startInteractiveCLI = () => render(<App />);
