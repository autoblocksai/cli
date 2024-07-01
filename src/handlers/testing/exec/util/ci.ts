import { z } from 'zod';
import github from '@actions/github';
import fs from 'fs/promises';

const AUTOBLOCKS_OVERRIDES_INPUT_NAME = 'autoblocks-overrides';

export interface CIContext {
  gitProvider: 'github';
  repoId: string;
  repoName: string;
  repoHtmlUrl: string;
  branchId: string;
  branchName: string;
  isDefaultBranch: boolean;
  ciProvider: 'github';
  buildHtmlUrl: string;
  workflowId: string;
  workflowName: string;
  workflowRunNumber: number;
  jobName: string;
  commitSha: string;
  commitMessage: string;
  commitCommitterName: string;
  commitCommitterEmail: string;
  commitAuthorName: string;
  commitAuthorEmail: string;
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

const zPullRequestSchema = z.object({
  number: z.coerce.number(),
  title: z.string(),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
  }),
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

export async function makeCIContext(): Promise<CIContext> {
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

  const [{ data: commit }, { data: ref }] = await Promise.all([
    // Get the commit via REST API since for pull requests the commit data
    // is for the last merge commit and not the head commit
    api.rest.git.getCommit({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      commit_sha: commitSha,
    }),
    // Get the branch via the REST API so we can get its internal node ID
    api.rest.git.getRef({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      ref: `heads/${branchName}`,
    }),
  ]);

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
    repoId: repository.id,
    // full repo name including owner, e.g. 'octocat/Hello-World'
    repoName: env.GITHUB_REPOSITORY,
    repoHtmlUrl: [env.GITHUB_SERVER_URL, env.GITHUB_REPOSITORY].join('/'),
    branchId: ref.node_id,
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
