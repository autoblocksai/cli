import { Box, Text, render, useApp } from 'ink';
import { useEffect, useState } from 'react';
import type { AsyncHandlerOf, Handler } from '../../../../util/types';
import { EventName, emitter } from '../util/emitter';
import {
  AfterGradeAction,
  type TestCaseResult,
  type GradedTestCaseResult,
  type AutogeneratedEvaluatorWithFilepath,
} from '../util/models';
import { AutogeneratedEvaluatorsList } from './AutogeneratedEvaluatorsList';
import { GradeTestCaseResultForm } from './GradeTestCaseResultForm';
import { GradedTestCaseResultsList } from './GradedTestCaseResultsList';
import { WaitingFor } from './WaitingFor';

interface AppProps {
  testExternalId: string;
  sessionId: string;
  testCaseHashes: () => string[];
  requestNextTestCaseResult: AsyncHandlerOf<{
    testCaseHash: string | undefined;
  }>;
  onTestCaseResultGraded: AsyncHandlerOf<GradedTestCaseResult>;
  autogenerateEvaluators: () => Promise<AutogeneratedEvaluatorWithFilepath[]>;
  onExit: Handler;
}

function App(props: AppProps) {
  const inkApp = useApp();

  // The test case result currently being graded
  const [currentTestCaseResult, setCurrentTestCaseResult] = useState<{
    isLoading: boolean;
    data: TestCaseResult | undefined;
  }>({
    isLoading: true,
    data: undefined,
  });

  // The test case results that have been graded so far
  const [gradedTestCaseResults, setGradedTestCaseResults] = useState<
    GradedTestCaseResult[]
  >([]);

  const [autogeneratedEvaluators, setAutogeneratedEvaluators] = useState<{
    isLoading: boolean;
    data: AutogeneratedEvaluatorWithFilepath[] | undefined;
  }>({
    // This is set to true when the user is done grading and we start
    // autogenerating evaluators
    isLoading: false,
    data: undefined,
  });

  const isLastTestCaseHash = (hash: string) => {
    const testCaseHashes = props.testCaseHashes();
    return testCaseHashes[testCaseHashes.length - 1] === hash;
  };

  const isGradingLastTestCase: boolean =
    currentTestCaseResult.data !== undefined &&
    isLastTestCaseHash(currentTestCaseResult.data.testCaseHash);

  const requestNextTestCaseResult = async (args: {
    prevHash: string | undefined;
  }) => {
    setCurrentTestCaseResult({
      isLoading: true,
      data: undefined,
    });

    if (args.prevHash) {
      const testCaseHashes = props.testCaseHashes();
      const prevHashIdx = testCaseHashes.indexOf(args.prevHash);
      if (prevHashIdx === -1) {
        throw new Error('Previous hash not found');
      }
      const nextTestCaseHash = testCaseHashes[prevHashIdx + 1];
      if (!nextTestCaseHash) {
        throw new Error('No more test cases');
      }
      await props.requestNextTestCaseResult({ testCaseHash: nextTestCaseHash });
    } else {
      // SDK will run first test case if no hash is specified
      await props.requestNextTestCaseResult({ testCaseHash: undefined });
    }
  };

  const onTestCaseResultGraded = async (args: {
    accepted: boolean;
    reason: string | undefined;
  }) => {
    if (!currentTestCaseResult.data) {
      return;
    }

    const gradedResult: GradedTestCaseResult = {
      testExternalId: props.testExternalId,
      testCaseHash: currentTestCaseResult.data.testCaseHash,
      testCaseBody: currentTestCaseResult.data.testCaseBody,
      testCaseOutput: currentTestCaseResult.data.testCaseOutput,
      grade: {
        type: 'binary',
        accepted: args.accepted,
        reason: args.reason,
      },
    };

    setGradedTestCaseResults([...gradedTestCaseResults, gradedResult]);
    await props.onTestCaseResultGraded(gradedResult);
  };

  const onAfterGradeAction = async (action: AfterGradeAction) => {
    if (!currentTestCaseResult.data) {
      return;
    }

    switch (action) {
      case AfterGradeAction.GRADE_NEXT: {
        const prevHash = currentTestCaseResult.data.testCaseHash;
        await requestNextTestCaseResult({ prevHash });
        break;
      }
      case AfterGradeAction.STOP_GRADING: {
        setCurrentTestCaseResult({
          isLoading: false,
          data: undefined,
        });
        setAutogeneratedEvaluators({
          isLoading: true,
          data: undefined,
        });
        const autogeneratedEvaluators = await props.autogenerateEvaluators();
        setAutogeneratedEvaluators({
          isLoading: false,
          data: autogeneratedEvaluators,
        });
        props.onExit();
        inkApp.exit();
        break;
      }
    }
  };

  useEffect(() => {
    // Set up listener for test case results
    const testCaseResultListener = (result: TestCaseResult) => {
      setCurrentTestCaseResult({
        isLoading: false,
        data: result,
      });
    };

    emitter.on(EventName.TEST_CASE_RESULT, testCaseResultListener);

    // Request the first test case result
    (async () => {
      await requestNextTestCaseResult({ prevHash: undefined });
    })();

    return () => {
      // Clean up listener on unmount
      emitter.off(EventName.TEST_CASE_RESULT, testCaseResultListener);
    };
  }, []);

  return (
    <Box flexDirection="column" rowGap={1}>
      <Box columnGap={2}>
        <Box flexDirection="column">
          <Text color="cyan">Test Suite ID</Text>
          <Text color="cyan">Session ID</Text>
          <Text color="cyan">Grading History</Text>
        </Box>
        <Box flexDirection="column">
          <Text>{props.testExternalId}</Text>
          <Text>{props.sessionId}</Text>
          <GradedTestCaseResultsList
            testCaseHashes={props.testCaseHashes()}
            gradedTestCaseResults={gradedTestCaseResults}
          />
        </Box>
      </Box>
      <Box>
        {(() => {
          if (autogeneratedEvaluators.isLoading) {
            return (
              <WaitingFor message="Generating evaluators based on your responses" />
            );
          } else if (autogeneratedEvaluators.data) {
            return (
              <AutogeneratedEvaluatorsList
                evaluators={autogeneratedEvaluators.data}
              />
            );
          } else if (currentTestCaseResult.isLoading) {
            return <WaitingFor message="Waiting for test case result" />;
          } else if (currentTestCaseResult.data) {
            return (
              <GradeTestCaseResultForm
                body={currentTestCaseResult.data.testCaseBody}
                output={currentTestCaseResult.data.testCaseOutput}
                onGraded={onTestCaseResultGraded}
                onAfterGradeAction={onAfterGradeAction}
                isGradingLastTestCase={isGradingLastTestCase}
              />
            );
          }
          return null;
        })()}
      </Box>
    </Box>
  );
}

export function renderApp(args: AppProps) {
  return render(<App {...args} />);
}
