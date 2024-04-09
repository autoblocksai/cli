import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

export function WaitingFor(props: { message: string }) {
  return (
    <Box columnGap={1}>
      <Spinner type="dots" />
      <Text color="gray">{props.message}</Text>
    </Box>
  );
}
