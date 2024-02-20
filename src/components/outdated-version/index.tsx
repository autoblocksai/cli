import { Box, Text, render } from 'ink';

function OutdatedVersion(props: {
  currentVersion: string;
  latestVersion: string;
}) {
  return (
    <Box
      padding={1}
      flexDirection="column"
      borderColor="yellow"
      borderStyle="round"
      alignItems="center"
      justifyContent="center"
    >
      <Box>
        <Text>
          Update available <Text color="gray">v{props.currentVersion}</Text> ≫{' '}
          <Text color="green" bold={true}>
            v{props.latestVersion}
          </Text>
        </Text>
      </Box>
      <Box>
        <Text>
          Run{' '}
          <Text color="cyan" bold={true}>
            {'npx @autoblocks/cli@latest <command>'}
          </Text>{' '}
          to use the latest version
        </Text>
      </Box>
    </Box>
  );
}

export const renderOutdatedVersionComponent = (args: {
  currentVersion: string;
  latestVersion: string;
}) => {
  const { unmount } = render(
    <OutdatedVersion
      currentVersion={args.currentVersion}
      latestVersion={args.latestVersion}
    />,
  );
  unmount();
};
