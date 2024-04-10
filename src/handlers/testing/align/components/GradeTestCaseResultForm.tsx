import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import type { AsyncHandlerOf } from '../../../../util/types';
import { AfterGradeAction } from '../util/models';
import { AfterGradeSelectAction } from './AfterGradeSelectAction';
import { Question } from './Question';

enum BinaryGrade {
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
}

export function GradeTestCaseResultForm(props: {
  body: unknown;
  output: unknown;
  onGraded: AsyncHandlerOf<{ accepted: boolean; reason: string | undefined }>;
  onAfterGradeAction: AsyncHandlerOf<AfterGradeAction>;
  isGradingLastTestCase: boolean;
}) {
  const stringifiedBody = JSON.stringify(props.body, null, 2);
  const stringifiedOutput =
    typeof props.output === 'string'
      ? props.output
      : JSON.stringify(props.output, null, 2);
  const [grade, setGrade] = useState<BinaryGrade | undefined>();
  const [reason, setReason] = useState('');
  const [didSubmitReason, setDidSubmitReason] = useState<boolean>(false);
  const [showAfterGradeSelectAction, setShowAfterGradeSelectAction] =
    useState(false);

  const gradeItems = [
    { label: '✓ This looks good', value: BinaryGrade.ACCEPTED },
    {
      label: '✗ This is not what I was expecting',
      value: BinaryGrade.REJECTED,
    },
  ];
  const selectedGradeLabel = gradeItems.find(
    (item) => item.value === grade,
  )?.label;

  return (
    <Box flexDirection="column" rowGap={1} width="100%">
      <Box
        flexDirection="column"
        rowGap={1}
        borderStyle="round"
        borderColor="gray"
        width="100%"
      >
        <Text bold={true}>Test Case</Text>
        <Text color="yellow" wrap="wrap">
          {stringifiedBody}
        </Text>
        <Text bold={true}>Output</Text>
        <Text color="yellow" wrap="wrap">
          {stringifiedOutput}
        </Text>
      </Box>
      <Box flexDirection="column">
        <Question question="What do you think of this output?" />
        {grade === undefined ? (
          // If grade hasn't been selected yet, show the grade selection menu.
          <SelectInput
            items={gradeItems}
            onSelect={({ value }) => {
              setGrade(value);
            }}
          />
        ) : (
          // Once the grade has been selected, show the selected grade.
          <Text>{selectedGradeLabel}</Text>
        )}
      </Box>
      {/* Once the grade has been selected, ask the user why they gave the output the given grade. */}
      {grade !== undefined && (
        <Box flexDirection="column">
          <Question
            question={grade === BinaryGrade.ACCEPTED ? 'Why?' : 'Why not?'}
            hint="(Enter to skip)"
          />
          {didSubmitReason ? (
            <Text>{reason}</Text>
          ) : (
            <TextInput
              value={reason}
              onChange={setReason}
              onSubmit={async () => {
                await props.onGraded({
                  accepted: grade === BinaryGrade.ACCEPTED,
                  // Convert empty string to undefined
                  reason: reason || undefined,
                });
                setDidSubmitReason(true);

                if (props.isGradingLastTestCase) {
                  props.onAfterGradeAction(AfterGradeAction.STOP_GRADING);
                } else {
                  setShowAfterGradeSelectAction(true);
                }
              }}
            />
          )}
        </Box>
      )}
      {showAfterGradeSelectAction && (
        <AfterGradeSelectAction onSelect={props.onAfterGradeAction} />
      )}
    </Box>
  );
}
