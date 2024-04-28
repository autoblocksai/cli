import { z } from 'zod';
import github from '@actions/github';
import fs from 'fs/promises';

export interface CIContext {
  gitProvider: 'github';
  repoId: string;
  repoName: string;
  repoHtmlUrl: string;
  branchId: string;
  branchName: string;
  defaultBranchName: string;
  ciProvider: 'github';
  buildHtmlUrl: string;
  workflowName: string;
  workflowRunNumber: string;
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
  GITHUB_RUN_NUMBER: z.string(),
});

const zPullRequestSchema = z.object({
  number: z.number(),
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
  // Map of prompt external ID to a prompt revision ID
  promptRevisions: z.record(z.string(), z.string()),
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
  const overridesRaw = event.inputs?.['autoblocks-overrides'];
  if (!overridesRaw) {
    return null;
  }

  // This will throw if autoblocks-overrides is not valid, but that is
  // desired because we want to stop the workflow if the input is defined
  // but not what we expect.
  return zAutoblocksOverridesSchema.parse(JSON.parse(`${overridesRaw}`));
}

export async function makeCIContext(): Promise<CIContext> {
  const env = zGitHubEnvSchema.parse(process.env);
  const api = github.getOctokit(env.GITHUB_TOKEN);

  // GitHub Actions are triggered by webhook events, and the event payload is
  // stored in a JSON file at $GITHUB_EVENT_PATH.
  // You can see the schema of the various webhook payloads at:
  // https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads
  const event = JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH, 'utf-8'));

  const repository = repositoryFromEvent(event);
  const pullRequest = pullRequestFromEvent(event);
  const autoblocksOverrides = autoblocksOverridesFromEvent(event);

  // The GITHUB_SHA env var for pull request events is the last merge commit
  // on GITHUB_REF, but we want the commit sha of the head commit of the PR.
  const commitSha = pullRequest?.head.sha || env.GITHUB_SHA;

  // Get the commit via REST API since for pull requests the commit data
  // is for the last merge commit and not the head commit.
  const { data: commit } = await api.rest.git.getCommit({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    commit_sha: commitSha,
  });

  // When it's a `push` event, the branch name is in `GITHUB_REF_NAME`, but on the `pull_request`
  // event we want to use event.pull_request.head.ref, since `GITHUB_REF_NAME` will contain the
  // name of the merge commit for the PR, like 5/merge.
  const branchName = pullRequest?.head.ref || env.GITHUB_REF_NAME;

  // Get the branch via the REST API so we can get its internal node ID
  const { data: ref } = await api.rest.git.getRef({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    ref: `heads/${branchName}`,
  });

  return {
    gitProvider: 'github',
    repoId: repository.id,
    // full repo name including owner, e.g. 'octocat/Hello-World'
    repoName: env.GITHUB_REPOSITORY,
    repoHtmlUrl: [env.GITHUB_SERVER_URL, env.GITHUB_REPOSITORY].join('/'),
    branchId: ref.node_id,
    branchName,
    defaultBranchName: repository.default_branch,
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
    workflowName: env.GITHUB_WORKFLOW,
    workflowRunNumber: env.GITHUB_RUN_NUMBER,
    commitSha: commit.sha,
    commitMessage: commit.message.split('\n')[0],
    commitCommitterName: commit.committer.name,
    commitCommitterEmail: commit.committer.email,
    commitAuthorName: commit.author.name,
    commitAuthorEmail: commit.author.email,
    commitCommittedDate: commit.author.date,
    pullRequestNumber: pullRequest?.number ?? null,
    pullRequestTitle: pullRequest?.title || null,
    autoblocksOverrides: autoblocksOverrides,
  };
}
