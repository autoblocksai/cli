import { Box, Static, Text, render } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useState } from 'react';
import { EventName, emitter, type EventSchemas } from '../../util/emitter';
import { makeTestRunStatusFromEvaluations } from '../../util/evals';
import { EvaluationPassed, TestRunStatus } from '../../util/models';
import {
  makeAutoblocksCIBuildSummaryHtmlUrl,
  makeAutoblocksLocalTestResultsHtmlUrl,
  makeAutoblocksCITestResultsHtmlUrl,
  makeAutoblocksHumanReviewHtmlUrl,
} from '../../util/url';

type ConsoleLog = EventSchemas[EventName.CONSOLE_LOG];
type UncaughtError = EventSchemas[EventName.UNCAUGHT_ERROR];
type Evaluation = EventSchemas[EventName.EVALUATION];
type RunStarted = EventSchemas[EventName.RUN_STARTED];
type RunEnded = EventSchemas[EventName.RUN_ENDED];

interface AppProps {
  onListenersCreated: () => void;
  ciBranchId: string | undefined;
  ciBuildId: string | undefined;
}

interface RunMeta {
  id: string;
  ended: boolean;
  shareUrl: string | undefined;
}

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

const Space = () => <Text> </Text>;

function makeColorFromEvaluationPassed(
  passed: EvaluationPassed | undefined,
): string {
  switch (passed) {
    case EvaluationPassed.TRUE:
      return 'green';
    case EvaluationPassed.FALSE:
      return 'red';
    case EvaluationPassed.NOT_APPLICABLE:
      return 'yellow';
    case undefined:
      // This means the test case has been seen but this particular evaluator
      // has not evaluated it yet. In this case we show a gray dot.
      return 'gray';
    default:
      return 'gray';
  }
}

function makeColorFromLogLevel(
  level: 'debug' | 'info' | 'warn' | 'error',
): string {
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
  testExternalId: string;
  ciBranchId: string | undefined;
  runMeta: RunMeta | undefined;
  evals: Evaluation[];
  errors: UncaughtError[];
}) {
  const uniqEvaluatorExternalIds = uniq(
    props.evals.map((e) => e.evaluatorExternalId),
  );
  const uniqTestCaseHashes = uniq(props.evals.map((e) => e.testCaseHash));

  const testStatus = makeTestRunStatusFromEvaluations(props.evals);
  const statusToColorAndIcon: Record<
    TestRunStatus,
    { color: string; icon: string }
  > = {
    [TestRunStatus.PASSED]: { color: 'green', icon: '✓' },
    [TestRunStatus.FAILED]: { color: 'red', icon: '✗' },
    [TestRunStatus.NO_RESULTS]: { color: 'gray', icon: '?' },
  };
  const { color: testStatusColor, icon: testStatusIcon } =
    statusToColorAndIcon[testStatus];

  const resultsUrl: string | null = (() => {
    if (!process.env.CI) {
      return makeAutoblocksLocalTestResultsHtmlUrl({
        testExternalId: props.testExternalId,
      });
    }
    if (props.ciBranchId) {
      return makeAutoblocksCITestResultsHtmlUrl({
        testExternalId: props.testExternalId,
        branchId: props.ciBranchId,
      });
    }
    return null;
  })();

  return (
    <Box flexDirection="column">
      <Box columnGap={1}>
        {props.runMeta?.ended ? (
          <Text color={testStatusColor}>{testStatusIcon}</Text>
        ) : (
          <Spinner type="dots" />
        )}
        <Text bold={true}>{props.testExternalId}</Text>
      </Box>
      <Box paddingLeft={2} columnGap={2}>
        {props.runMeta?.ended && testStatus === TestRunStatus.NO_RESULTS && (
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
                    // If this is undefined it means that this evaluator has not
                    // evaluated this test case yet.
                    const passed: EvaluationPassed | undefined =
                      props.evals.find(
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
                          hasUncaughtError
                            ? 'white'
                            : makeColorFromEvaluationPassed(passed)
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
      {/* Links */}
      <Box flexDirection="column" paddingTop={1} paddingLeft={2}>
        {resultsUrl && <ExternalLink name="Results" url={resultsUrl} />}
        {props.runMeta && (
          <ExternalLink
            name="Human Review"
            url={makeAutoblocksHumanReviewHtmlUrl({
              testExternalId: props.testExternalId,
              runId: props.runMeta.id,
            })}
          />
        )}
      </Box>
    </Box>
  );
}

function ExternalLink(props: { name: string; url: string }) {
  const prefix = '>>';
  const columnGap = 1;
  // Hardcode the width so that it doesn't wrap in CI terminals
  const width = [prefix, props.name, props.url].join(
    ' '.repeat(columnGap),
  ).length;
  return (
    <Box columnGap={columnGap} width={width}>
      <Text>{prefix}</Text>
      <Text>{props.name}</Text>
      <Text color="cyan" dimColor={true}>
        {props.url}
      </Text>
    </Box>
  );
}

const App = (props: AppProps) => {
  const [testExternalIds, setTestExternalIds] = useState<string[]>([]);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([]);
  const [uncaughtErrors, setUncaughtErrors] = useState<UncaughtError[]>([]);
  const [evals, setEvals] = useState<Evaluation[]>([]);
  const [testIdToRunMeta, setTestIdToRunMeta] = useState<
    Record<string, RunMeta>
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
      setTestIdToRunMeta((prev) => {
        return {
          ...prev,
          [runEnded.testExternalId]: {
            id: runEnded.id,
            ended: true,
            shareUrl: runEnded.shareUrl,
          },
        };
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
              <Text color={makeColorFromLogLevel(log.level)} bold={true}>
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
        width="100%"
        flexDirection="column"
      >
        <Box paddingX={1} flexDirection="column" minHeight={12} rowGap={1}>
          {testExternalIds.length === 0 && (
            <Box>
              <Text color="gray">
                Waiting for test results
                <Spinner type="simpleDots" />
              </Text>
            </Box>
          )}
          {testExternalIds.map((testExternalId) => {
            const runMeta = testIdToRunMeta[testExternalId];
            const testEvals = evals.filter(
              (e) => e.testExternalId === testExternalId,
            );
            const testErrors = uncaughtErrors.filter(
              (e) => e.testExternalId === testExternalId,
            );
            return (
              <TestRow
                key={testExternalId}
                testExternalId={testExternalId}
                ciBranchId={props.ciBranchId}
                runMeta={runMeta}
                evals={testEvals}
                errors={testErrors}
              />
            );
          })}
        </Box>
      </Box>
      {/* Links */}
      <Box flexDirection="column" paddingTop={1}>
        {props.ciBranchId && props.ciBuildId && (
          <ExternalLink
            name="Build Summary"
            url={makeAutoblocksCIBuildSummaryHtmlUrl({
              branchId: props.ciBranchId,
              buildId: props.ciBuildId,
            })}
          />
        )}
      </Box>
    </>
  );
};

export const renderTestProgress = (args: AppProps) => render(<App {...args} />);
