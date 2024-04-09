import { Box } from 'ink';
import SelectInput from 'ink-select-input';
import type { AsyncHandlerOf } from '../../../../util/types';
import { AfterGradeAction } from '../util/models';
import { Question } from './Question';

export function AfterGradeSelectAction(props: {
  onSelect: AsyncHandlerOf<AfterGradeAction>;
}) {
  const items = [
    {
      label: 'Move to next test case',
      value: AfterGradeAction.GRADE_NEXT,
    },
    {
      label: 'Stop grading and generate evaluators',
      value: AfterGradeAction.STOP_GRADING,
    },
  ];
  return (
    <Box flexDirection="column">
      <Question question="What do you want to do next?" />
      <SelectInput
        items={items}
        onSelect={async (item) => {
          await props.onSelect(item.value);
        }}
      />
    </Box>
  );
}
