import { Box, Text } from 'ink';
import { type GradedTestCaseResult, type Grade } from '../util/models';

export function GradedTestCaseResultsList(props: {
  testCaseHashes: string[];
  gradedTestCaseResults: GradedTestCaseResult[];
}) {
  return (
    <Box flexDirection="column">
      {props.gradedTestCaseResults.map((gradedTestCaseResult, idx) => {
        return (
          <GradedResult
            key={idx}
            testCaseHash={gradedTestCaseResult.testCaseHash}
            testCaseHashes={props.testCaseHashes}
            grade={gradedTestCaseResult.grade}
          />
        );
      })}
    </Box>
  );
}

function GradedResult(props: {
  testCaseHash: string;
  testCaseHashes: string[];
  grade: Grade;
}) {
  if (props.grade.type !== 'binary') {
    return null;
  }

  const testCaseIdx = props.testCaseHashes.indexOf(props.testCaseHash);
  const numTestCases = props.testCaseHashes.length;

  const maxDigits = `${numTestCases}`.length;
  const paddedIdx = `${testCaseIdx + 1}`.padStart(maxDigits, '0');

  return (
    <Box columnGap={1}>
      <Text color="gray">
        {'['}
        {props.testCaseHash.slice(0, 7)}
        {']'}
      </Text>
      <Text color="gray">
        {'['}
        {paddedIdx} / {numTestCases}
        {']'}
      </Text>
      <Text color={props.grade.accepted ? 'green' : 'red'}>
        {props.grade.accepted ? '✓' : '✗'}
      </Text>
      {props.grade.reason && <Text color="gray">{props.grade.reason}</Text>}
    </Box>
  );
}
