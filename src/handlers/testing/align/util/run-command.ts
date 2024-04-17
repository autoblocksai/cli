import { exec as execCommand } from '@actions/exec';

export async function runCommandInAlignmentMode(args: {
  command: string;
  commandArgs: string[];
  cliServerAddress: string;
  testExternalId: string;
  testCaseHash: string | undefined;
}) {
  const env: Record<string, string> = {
    ...process.env,
    AUTOBLOCKS_CLI_SERVER_ADDRESS: args.cliServerAddress,
    AUTOBLOCKS_ALIGN_TEST_EXTERNAL_ID: args.testExternalId,
  };
  if (args.testCaseHash) {
    env.AUTOBLOCKS_ALIGN_TEST_CASE_HASH = args.testCaseHash;
  }

  try {
    await execCommand(args.command, args.commandArgs, {
      silent: true,
      env,
    });
  } catch (err) {
    // TODO handle errors
  }
}
