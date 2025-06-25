import { SDKEnvironmentVariable } from '../../../util/sdk-env';
import * as core from '@actions/core';
import { setupCIContext as setupCIContextUtil } from '../../../util/ci';
import { execSync } from 'child_process';

export async function setupCIContext(args: {
  apiKey?: string;
  apiKeyV2?: string;
  slackWebhookUrl?: string;
  apiEndpointV2?: string;
}) {
  let result;
  try {
    result = await setupCIContextUtil({
      apiKey: args.apiKey,
      apiKeyV2: args.apiKeyV2,
      apiEndpointV2: args.apiEndpointV2,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    core.setFailed(`Failed to setup CI context for Autoblocks testing`);
    process.exit(1);
  }

  if (result) {
    // eslint-disable-next-line no-console
    console.log(
      `Running in CI environment: ${JSON.stringify(result.ciContext, null, 2)}`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.error('Failed to setup CI context for Autoblocks testing.');
    core.setFailed('Failed to setup CI context for Autoblocks testing.');
    process.exit(1);
  }

  const envVars = {
    [SDKEnvironmentVariable.AUTOBLOCKS_CI_TEST_RUN_BUILD_ID]:
      result.v1?.buildId,
    [SDKEnvironmentVariable.AUTOBLOCKS_V2_CI_TEST_RUN_BUILD_ID]:
      result.v2?.buildId,
    [SDKEnvironmentVariable.AUTOBLOCKS_SLACK_WEBHOOK_URL]: args.slackWebhookUrl,
    [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_TESTS_AND_HASHES]:
      result.ciContext.autoblocksOverrides?.testsAndHashes,
    [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_PROMPT_REVISIONS]:
      result.ciContext.autoblocksOverrides?.promptRevisions,
    [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_CONFIG_REVISIONS]:
      result.ciContext.autoblocksOverrides?.configRevisions,
  };

  if (result.ciContext.ciProvider === 'github') {
    Object.entries(envVars).forEach(([key, value]) => {
      core.exportVariable(key, value);
      core.setOutput(key, value);
    });
  } else if (result.ciContext.ciProvider === 'codefresh') {
    Object.entries(envVars).forEach(([key, value]) => {
      // This has to be done in a step before the tests are run
      // https://codefresh.io/docs/docs/pipelines/variables/#exporting-variables-with-cf_export
      try {
        execSync(`cf_export ${key}=${value}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`Failed to set environment variable ${key}: ${err}`);
      }
    });
  } else {
    // eslint-disable-next-line no-console
    console.error(
      'Unsupported CI provider. Could not set environment variables.',
    );
  }
}
