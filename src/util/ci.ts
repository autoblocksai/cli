import { z } from 'zod';
import github from '@actions/github';
import fs from 'fs/promises';
import { post } from './api';

const AUTOBLOCKS_OVERRIDES_INPUT_NAME = 'autoblocks-overrides';
const CODEFRESH_EVENT_PATH = '/codefresh/volume/event.json';

export interface CIContext {
  gitProvider: 'github';
  repoName: string;
  repoHtmlUrl: string;
  branchName: string;
  isDefaultBranch: boolean;
  ciProvider: 'github' | 'codefresh';
  buildHtmlUrl: string;
  workflowId: string;
  workflowName: string;
  workflowRunNumber: number | null;
  jobName: string | null;
  commitSha: string;
  commitMessage: string;
  commitCommitterName: string;
  commitCommitterEmail: string | null;
  commitAuthorName: string;
  commitAuthorEmail: string | null;
  commitCommittedDate: string;
  pullRequestNumber: number | null;
  pullRequestTitle: string | null;
  // The Autoblocks overrides that triggered this test run, if any.
  // This is parsed from the GitHub Actions workflow inputs.
  autoblocksOverrides: AutoblocksOverrides | null;
}

const zGitHubEnvSchema = z.object({
  GITHUB_ACTIONS: z.literal('true'),
  GITHUB_TOKEN: z.string(),
  GITHUB_SERVER_URL: z.string(),
  GITHUB_REPOSITORY: z.string(),
  GITHUB_REF_NAME: z.string(),
  GITHUB_EVENT_PATH: z.string(),
  GITHUB_SHA: z.string(),
  GITHUB_RUN_ID: z.string(),
  GITHUB_RUN_ATTEMPT: z.string(),
  GITHUB_WORKFLOW: z.string(),
  GITHUB_WORKFLOW_REF: z.string(),
  GITHUB_RUN_NUMBER: z.coerce.number(),
  GITHUB_JOB: z.string(),
});

// https://codefresh.io/docs/docs/pipelines/variables/
const zCodefreshEnvSchema = z.object({
  CF_REPO_OWNER: z.string(),
  CF_REPO_NAME: z.string(),
  CF_BRANCH: z.string(), // branch name
  CF_PULL_REQUEST_NUMBER: z.coerce.number().nullish(),
  CF_PULL_REQUEST_TITLE: z.string().nullish(),
  CF_COMMIT_AUTHOR: z.string(), // name (not email)
  CF_COMMIT_MESSAGE: z.string(),
  CF_REVISION: z.string(), // commit sha
  CF_BUILD_URL: z.string(), // build URL to codefresh
  CF_COMMIT_URL: z.string(),
  CF_PIPELINE_NAME: z.string(),
});

const zPullRequestSchema = z.object({
  number: z.coerce.number(),
  title: z.string(),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
  }),
});

const zCodefreshEventSchema = z.object({
  repository: z.object({
    full_name: z.string(),
    html_url: z.string(),
    default_branch: z.string(),
  }),
  head_commit: z.object({
    timestamp: z.string(),
    author: z.object({
      name: z.string(),
      email: z.string(),
    }),
    committer: z.object({
      name: z.string(),
      email: z.string(),
    }),
  }),
  pull_request: zPullRequestSchema.nullish(),
});

const zRepositorySchema = z.object({
  id: z.coerce.string(),
  default_branch: z.string(),
});

const zAutoblocksOverridesSchema = z.object({
  // Map of test external ID to list of test case hashes
  testsAndHashes: z.record(z.string(), z.array(z.string())).optional(),
  // Map of prompt external ID to a prompt revision ID
  promptRevisions: z.record(z.string(), z.string()).optional(),
  // Map of config external ID to a config revision ID
  configRevisions: z.record(z.string(), z.string()).optional(),
});

type PullRequest = z.infer<typeof zPullRequestSchema>;
type Repository = z.infer<typeof zRepositorySchema>;
type AutoblocksOverrides = z.infer<typeof zAutoblocksOverridesSchema>;

function pullRequestFromEvent(event: {
  pull_request?: unknown;
}): PullRequest | null {
  const parsed = zPullRequestSchema.safeParse(event.pull_request);
  if (parsed.success) {
    return parsed.data;
  }
  return null;
}

function repositoryFromEvent(event: { repository?: unknown }): Repository {
  return zRepositorySchema.parse(event.repository);
}

/**
 * For users with UI-triggered test runs configured, they'll
 * have their GitHub Actions workflow set up to receive Autoblocks
 * overrides serialized as a string input. This function is used to
 * parse that input out of the event.json file, which will
 * contain the workflow event payload.
 */
function autoblocksOverridesFromEvent(event: {
  inputs?: Record<string, unknown>;
}): AutoblocksOverrides | null {
  const overridesRaw = event.inputs?.[AUTOBLOCKS_OVERRIDES_INPUT_NAME];
  if (!overridesRaw) {
    return null;
  }

  // This will throw if autoblocks-overrides is not valid, but that is
  // desired because we want to stop the workflow if the input is defined
  // but not what we expect.
  return zAutoblocksOverridesSchema.parse(JSON.parse(`${overridesRaw}`));
}

/**
 * Parses the workflow ID out of the workflow ref. For example:
 *
 * "workflow_ref": "autoblocksai/cli/.github/workflows/e2e.yml@refs/heads/nicole/epd-868-cli-pass-along-testcaserevisionusage"
 *
 * Workflow ID: e2e.yml
 */
function parseWorkflowIdFromWorkflowRef(args: { workflowRef: string }): string {
  const parts = args.workflowRef.split('@refs/');
  const workflowPath = parts[0];
  const workflowParts = workflowPath.split('/');
  return workflowParts[workflowParts.length - 1];
}

async function makeCIContext(): Promise<CIContext> {
  const githubEnv = zGitHubEnvSchema.safeParse(process.env);
  if (githubEnv.success) {
    return makeGithubCIContext();
  }
  const codefreshEnv = zCodefreshEnvSchema.safeParse(process.env);
  if (codefreshEnv.success) {
    return makeCodefreshCIContext();
  }
  throw new Error(
    'Failed to make CI context. Are you using a supported CI provider? Reach out to support@autoblocks.ai for assistance.',
  );
}

async function makeCodefreshCIContext(): Promise<CIContext> {
  const env = zCodefreshEnvSchema.parse(process.env);
  let parsedEvent: null | z.infer<typeof zCodefreshEventSchema> = null;
  try {
    // https://codefresh.io/docs/docs/pipelines/triggers/git-triggers/
    const eventRaw = JSON.parse(
      await fs.readFile(CODEFRESH_EVENT_PATH, 'utf-8'),
    );
    parsedEvent = zCodefreshEventSchema.parse(eventRaw);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      'Failed to read event.json from GitHub webhook trigger. Using Codefresh environment variables as fallback.',
    );
  }

  const repoHtmlUrl =
    parsedEvent?.repository.html_url ??
    env.CF_COMMIT_URL.split(`/commit/${env.CF_REVISION}`)[0];
  const repoName =
    parsedEvent?.repository.full_name ??
    `${env.CF_REPO_OWNER}/${env.CF_REPO_NAME}`;

  let pullRequestNumber: number | null = null;
  if (
    env.CF_PULL_REQUEST_NUMBER !== null &&
    env.CF_PULL_REQUEST_NUMBER !== undefined
  ) {
    pullRequestNumber = env.CF_PULL_REQUEST_NUMBER;
  } else if (parsedEvent?.pull_request) {
    pullRequestNumber = parsedEvent.pull_request.number;
  }

  let pullRequestTitle: string | null = null;
  if (
    env.CF_PULL_REQUEST_TITLE !== null &&
    env.CF_PULL_REQUEST_TITLE !== undefined
  ) {
    pullRequestTitle = env.CF_PULL_REQUEST_TITLE;
  } else if (parsedEvent?.pull_request) {
    pullRequestTitle = parsedEvent.pull_request.title;
  }

  return {
    gitProvider: 'github',
    ciProvider: 'codefresh',
    repoName,
    repoHtmlUrl,
    branchName: env.CF_BRANCH,
    isDefaultBranch: env.CF_BRANCH === parsedEvent?.repository.default_branch,
    buildHtmlUrl: env.CF_BUILD_URL,
    workflowId: env.CF_PIPELINE_NAME,
    workflowName: env.CF_PIPELINE_NAME,
    workflowRunNumber: null,
    jobName: null,
    commitSha: env.CF_REVISION,
    commitMessage: env.CF_COMMIT_MESSAGE,
    commitAuthorName:
      parsedEvent?.head_commit.author.name ?? env.CF_COMMIT_AUTHOR,
    commitAuthorEmail: parsedEvent?.head_commit.author.email ?? null,
    commitCommitterName:
      parsedEvent?.head_commit.committer.name ?? env.CF_COMMIT_AUTHOR,
    commitCommitterEmail: parsedEvent?.head_commit.committer.email ?? null,
    commitCommittedDate: parsedEvent?.head_commit.timestamp
      ? new Date(parsedEvent.head_commit.timestamp).toISOString()
      : new Date().toISOString(),
    pullRequestNumber,
    pullRequestTitle,
    autoblocksOverrides: null,
  };
}

async function makeGithubCIContext(): Promise<CIContext> {
  const env = zGitHubEnvSchema.parse(process.env);
  const api = github.getOctokit(env.GITHUB_TOKEN);

  // GitHub Actions are triggered by webhook events, and the event payload is
  // stored in a JSON file at $GITHUB_EVENT_PATH.
  // You can see the schema of the various webhook payloads at:
  // https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads
  const eventRaw = JSON.parse(
    await fs.readFile(env.GITHUB_EVENT_PATH, 'utf-8'),
  );

  const repository = repositoryFromEvent(eventRaw);
  const pullRequest = pullRequestFromEvent(eventRaw);
  const autoblocksOverrides = autoblocksOverridesFromEvent(eventRaw);

  const { commitSha, branchName } = pullRequest
    ? // For pull request events we want the commit sha and branch name of the head commit,
      // since for pull request events the commit data is for the last merge commit and not
      // the head commit
      // See https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#pull_request
      { commitSha: pullRequest.head.sha, branchName: pullRequest.head.ref }
    : // Otherwise we can use the GITHUB_SHA and GITHUB_REF_NAME env vars
      { commitSha: env.GITHUB_SHA, branchName: env.GITHUB_REF_NAME };

  // Get the commit via REST API since for pull requests the commit data
  // is for the last merge commit and not the head commit
  const { data: commit } = await api.rest.git.getCommit({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    commit_sha: commitSha,
  });

  let pullRequestNumber: number | null = null;
  let pullRequestTitle: string | null = null;
  if (!pullRequest) {
    // If the event is a `push` event, the pull request data won't be available in the event payload,
    // but we can get the associated pull requests via the REST API.
    try {
      const { data: associatedPullRequests } =
        await api.rest.repos.listPullRequestsAssociatedWithCommit({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          commit_sha: commitSha,
        });

      pullRequestNumber = associatedPullRequests[0]?.number ?? null;
      pullRequestTitle = associatedPullRequests[0]?.title || null;
    } catch {
      // Might not have permissions
    }
  } else {
    pullRequestNumber = pullRequest.number;
    pullRequestTitle = pullRequest.title;
  }

  return {
    gitProvider: 'github',
    // full repo name including owner, e.g. 'octocat/Hello-World'
    repoName: env.GITHUB_REPOSITORY,
    repoHtmlUrl: [env.GITHUB_SERVER_URL, env.GITHUB_REPOSITORY].join('/'),
    branchName,
    isDefaultBranch: branchName === repository.default_branch,
    ciProvider: 'github',
    buildHtmlUrl: [
      env.GITHUB_SERVER_URL,
      env.GITHUB_REPOSITORY,
      'actions',
      'runs',
      env.GITHUB_RUN_ID,
      'attempts',
      env.GITHUB_RUN_ATTEMPT,
    ].join('/'),
    workflowId: parseWorkflowIdFromWorkflowRef({
      workflowRef: env.GITHUB_WORKFLOW_REF,
    }),
    workflowName: env.GITHUB_WORKFLOW,
    workflowRunNumber: env.GITHUB_RUN_NUMBER,
    jobName: env.GITHUB_JOB,
    commitSha: commit.sha,
    commitMessage: commit.message.split('\n')[0],
    commitCommitterName: commit.committer.name,
    commitCommitterEmail: commit.committer.email,
    commitAuthorName: commit.author.name,
    commitAuthorEmail: commit.author.email,
    commitCommittedDate: commit.author.date,
    pullRequestNumber,
    pullRequestTitle,
    autoblocksOverrides: autoblocksOverrides,
  };
}

/**
 * Creates a new CI build on Autoblocks and returns the build ID, branch ID, and CI context.
 */
export async function setupCIContext(args: { apiKey: string }): Promise<{
  buildId: string;
  branchId: string;
  ciContext: CIContext;
} | null> {
  const ciContext = await makeCIContext();

  if (!ciContext) {
    return null;
  }

  const { id, branchId } = await post<{ id: string; branchId: string }>({
    path: '/testing/ci/builds',
    apiKey: args.apiKey,
    body: {
      gitProvider: ciContext.gitProvider,
      repositoryName: ciContext.repoName,
      repositoryHtmlUrl: ciContext.repoHtmlUrl,
      branchName: ciContext.branchName,
      isDefaultBranch: ciContext.isDefaultBranch,
      ciProvider: ciContext.ciProvider,
      buildHtmlUrl: ciContext.buildHtmlUrl,
      workflowId: ciContext.workflowId,
      workflowName: ciContext.workflowName,
      workflowRunNumber: ciContext.workflowRunNumber,
      jobName: ciContext.jobName,
      commitSha: ciContext.commitSha,
      commitMessage: ciContext.commitMessage,
      commitCommitterName: ciContext.commitCommitterName,
      commitCommitterEmail: ciContext.commitCommitterEmail,
      commitAuthorName: ciContext.commitAuthorName,
      commitAuthorEmail: ciContext.commitAuthorEmail,
      commitCommittedDate: ciContext.commitCommittedDate,
      pullRequestNumber: ciContext.pullRequestNumber,
      pullRequestTitle: ciContext.pullRequestTitle,
      autoblocksOverrides: ciContext.autoblocksOverrides,
    },
  });

  return {
    buildId: id,
    branchId,
    ciContext,
  };
}
