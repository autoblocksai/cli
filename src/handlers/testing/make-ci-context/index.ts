import { RunManager } from '../exec/util/run-manager';
import { SDKEnvironmentVariable, makeSDKEnvVars } from '../../../util/sdk-env';
import * as core from '@actions/core';

export async function makeCIContext(args: {
  apiKey: string;
  slackWebhookUrl?: string;
}) {
  const runManager = new RunManager({
    apiKey: args.apiKey,
    runMessage: undefined,
    includeShareUrl: false,
  });

  const resp = await runManager.setupCIContext();

  if (resp) {
    // eslint-disable-next-line no-console
    console.log(
      `Running in CI environment: ${JSON.stringify(resp.ciContext, null, 2)}`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log('Running in non-CI environment');
    process.exit(1);
  }
  const envVars = makeSDKEnvVars({
    [SDKEnvironmentVariable.AUTOBLOCKS_CI_TEST_RUN_BUILD_ID]: resp.buildId,
    [SDKEnvironmentVariable.AUTOBLOCKS_CI_TEST_RUN_SLACK_WEBHOOK_URL]:
      args.slackWebhookUrl,
  });

  Object.entries(envVars).forEach(([key, value]) => {
    core.exportVariable(key, value);
  });

  // makeSDKEnvVars({
  //   [SDKEnvironmentVariable.AUTOBLOCKS_API_KEY]: args.apiKey,
  //   [SDKEnvironmentVariable.AUTOBLOCKS_CLI_SERVER_ADDRESS]: serverAddress,
  //   [SDKEnvironmentVariable.AUTOBLOCKS_FILTERS_TEST_SUITES]:
  //     args.testSuites,
  //   [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_TESTS_AND_HASHES]:
  //     ciContext?.autoblocksOverrides?.testsAndHashes,
  //   [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_PROMPT_REVISIONS]:
  //     ciContext?.autoblocksOverrides?.promptRevisions,
  //   [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_CONFIG_REVISIONS]:
  //     ciContext?.autoblocksOverrides?.configRevisions,
  // })
}
