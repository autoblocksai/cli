import { SDKEnvironmentVariable, makeSDKEnvVars } from '../../../util/sdk-env';
import * as core from '@actions/core';
import { setupCIContext } from '../../../util/ci';

export async function makeCIContext(args: {
  apiKey: string;
  slackWebhookUrl?: string;
}) {
  let result;
  try {
    result = await setupCIContext({ apiKey: args.apiKey });
  } catch (err) {
    core.setFailed(`Failed to setup CI context for Autoblocks testing: ${err}`);
    process.exit(1);
  }

  if (result) {
    // eslint-disable-next-line no-console
    console.log(
      `Running in CI environment: ${JSON.stringify(result.ciContext, null, 2)}`,
    );
  } else {
    core.setFailed('Failed to setup CI context for Autoblocks testing.');
    process.exit(1);
  }
  const envVars = makeSDKEnvVars({
    [SDKEnvironmentVariable.AUTOBLOCKS_CI_TEST_RUN_BUILD_ID]: result.buildId,
    [SDKEnvironmentVariable.AUTOBLOCKS_CI_TEST_RUN_SLACK_WEBHOOK_URL]:
      args.slackWebhookUrl,
    [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_TESTS_AND_HASHES]:
      result.ciContext.autoblocksOverrides?.testsAndHashes,
    [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_PROMPT_REVISIONS]:
      result.ciContext.autoblocksOverrides?.promptRevisions,
    [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_CONFIG_REVISIONS]:
      result.ciContext.autoblocksOverrides?.configRevisions,
  });

  Object.entries(envVars).forEach(([key, value]) => {
    core.exportVariable(key, value);
  });
}
