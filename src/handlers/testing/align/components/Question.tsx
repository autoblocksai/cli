import { Box, Text } from 'ink';

export function Question(props: { question: string; hint?: string }) {
  return (
    <Box columnGap={1}>
      <Text color="green" bold={true}>
        ?
      </Text>
      <Text>{props.question}</Text>
      {props.hint && <Text color="gray">{props.hint}</Text>}
    </Box>
  );
}
