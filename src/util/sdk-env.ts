import { z } from 'zod';
import {
  AUTOBLOCKS_API_KEY_NAME,
  AUTOBLOCKS_SLACK_WEBHOOK_URL_NAME,
} from './constants';

export enum SDKEnvironmentVariable {
  // Used when running tests on CI without using exec to associate the results to a specific CI build
  AUTOBLOCKS_CI_TEST_RUN_BUILD_ID = 'AUTOBLOCKS_CI_TEST_RUN_BUILD_ID',
  // Used when running tests on CI to send Slack notifications
  AUTOBLOCKS_SLACK_WEBHOOK_URL = AUTOBLOCKS_SLACK_WEBHOOK_URL_NAME,
  AUTOBLOCKS_API_KEY = AUTOBLOCKS_API_KEY_NAME,
  // Used by commands where the SDKs communicate results to a server running in the CLI
  AUTOBLOCKS_CLI_SERVER_ADDRESS = 'AUTOBLOCKS_CLI_SERVER_ADDRESS',
  // Used in alignment mode to only run the given test suite
  AUTOBLOCKS_ALIGN_TEST_EXTERNAL_ID = 'AUTOBLOCKS_ALIGN_TEST_EXTERNAL_ID',
  // Used in alignment mode to only run the given test case
  AUTOBLOCKS_ALIGN_TEST_CASE_HASH = 'AUTOBLOCKS_ALIGN_TEST_CASE_HASH',
  // Used to filter to specific test suites
  // different from AUTOBLOCKS_OVERRIDES_TESTS_AND_HASHES
  // in that this does a fuzzy match on test suite ids rather than strict matching
  AUTOBLOCKS_FILTERS_TEST_SUITES = 'AUTOBLOCKS_FILTERS_TEST_SUITES',
  // Used in UI-triggered override mode to only run the given test suites and test cases
  AUTOBLOCKS_OVERRIDES_TESTS_AND_HASHES = 'AUTOBLOCKS_OVERRIDES_TESTS_AND_HASHES',
  // Used in UI-triggered override mode to override prompt SDK revisions
  AUTOBLOCKS_OVERRIDES_PROMPT_REVISIONS = 'AUTOBLOCKS_OVERRIDES_PROMPT_REVISIONS',
  // Used in UI-triggered override mode to override config SDK revisions
  AUTOBLOCKS_OVERRIDES_CONFIG_REVISIONS = 'AUTOBLOCKS_OVERRIDES_CONFIG_REVISIONS',
}

// Temporary to support old env var names that the SDKs rely on
const backwardsCompatMappings: Record<string, string[]> = {
  [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_PROMPT_REVISIONS]: [
    'AUTOBLOCKS_PROMPT_REVISIONS',
  ],
  [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_CONFIG_REVISIONS]: [
    'AUTOBLOCKS_CONFIG_REVISIONS',
  ],
};

const schemas = {
  [SDKEnvironmentVariable.AUTOBLOCKS_CI_TEST_RUN_BUILD_ID]: z.string(),
  [SDKEnvironmentVariable.AUTOBLOCKS_SLACK_WEBHOOK_URL]: z.string().url(),
  [SDKEnvironmentVariable.AUTOBLOCKS_API_KEY]: z.string(),
  [SDKEnvironmentVariable.AUTOBLOCKS_CLI_SERVER_ADDRESS]: z.string(),
  [SDKEnvironmentVariable.AUTOBLOCKS_ALIGN_TEST_EXTERNAL_ID]: z.string(),
  [SDKEnvironmentVariable.AUTOBLOCKS_ALIGN_TEST_CASE_HASH]: z.string(),
  // List of test suite ids to filter on
  [SDKEnvironmentVariable.AUTOBLOCKS_FILTERS_TEST_SUITES]: z.array(z.string()),
  // Map of test external ID to list of test case hashes
  [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_TESTS_AND_HASHES]: z.record(
    z.string(),
    z.array(z.string()),
  ),
  // Map of prompt external ID to prompt revision ID
  [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_PROMPT_REVISIONS]: z.record(
    z.string(),
    z.string(),
  ),
  // Map of config external ID to config revision ID
  [SDKEnvironmentVariable.AUTOBLOCKS_OVERRIDES_CONFIG_REVISIONS]: z.record(
    z.string(),
    z.string(),
  ),
};

type Schemas = {
  [K in SDKEnvironmentVariable]: z.infer<(typeof schemas)[K]>;
};

export function makeSDKEnvVars(args: Partial<Schemas>): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;

  Object.entries(args).forEach(([k, v]) => {
    if (v === undefined) {
      return;
    }

    const envKey = k as SDKEnvironmentVariable;
    const schema = schemas[envKey];
    const parsed = schema.parse(v);
    const envValue =
      typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    env[envKey] = envValue;

    backwardsCompatMappings[envKey]?.map((backwardCompatKey) => {
      env[backwardCompatKey] = envValue;
    });
  });

  return env;
}
