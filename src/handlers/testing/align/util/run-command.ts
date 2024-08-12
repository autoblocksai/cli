import { exec as execCommand } from '@actions/exec';
import {
  SDKEnvironmentVariable,
  makeSDKEnvVars,
} from '../../../../util/sdk-env';

export async function runCommandInAlignmentMode(args: {
  command: string;
  commandArgs: string[];
  cliServerAddress: string;
  testExternalId: string;
  testCaseHash: string | undefined;
}) {
  try {
    await execCommand(args.command, args.commandArgs, {
      silent: true,
      env: makeSDKEnvVars({
        [SDKEnvironmentVariable.AUTOBLOCKS_CLI_SERVER_ADDRESS]:
          args.cliServerAddress,
        [SDKEnvironmentVariable.AUTOBLOCKS_ALIGN_TEST_EXTERNAL_ID]:
          args.testExternalId,
        [SDKEnvironmentVariable.AUTOBLOCKS_ALIGN_TEST_CASE_HASH]:
          args.testCaseHash,
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (err) {
    // TODO handle errors
  }
}
