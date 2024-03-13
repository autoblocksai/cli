import { z } from 'zod';
import { getExecOutput } from '@actions/exec';
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
  commitSha: string;
  commitMessage: string;
  commitCommitterName: string;
  commitCommitterEmail: string;
  commitAuthorName: string;
  commitAuthorEmail: string;
  commitCommittedDate: string;
  pullRequestNumber: number | null;
  pullRequestTitle: string | null;
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
});

const zCommitSchema = z.object({
  sha: z.string(),
  message: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  committerName: z.string(),
  committerEmail: z.string(),
  committedDate: z.string(),
});

const zPullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  head: z.object({
    ref: z.string(),
  }),
});

const zRepositorySchema = z.object({
  id: z.coerce.string(),
  default_branch: z.string(),
});

type Commit = z.infer<typeof zCommitSchema>;
type PullRequest = z.infer<typeof zPullRequestSchema>;
type Repository = z.infer<typeof zRepositorySchema>;

function pullRequestFromEvent(event: unknown): PullRequest | null {
  const parsed = zPullRequestSchema.safeParse(event);
  if (parsed.success) {
    return parsed.data;
  }
  return null;
}

function repositoryFromEvent(event: unknown): Repository {
  return zRepositorySchema.parse(event);
}

async function parseCommitFromGitLog(sha: string): Promise<Commit> {
  const commitMessageKey = 'message';

  const logFormat = [
    'sha=%H',
    'authorName=%an',
    'authorEmail=%ae',
    'committerName=%cn',
    'committerEmail=%ce',
    'committedDate=%aI',
    // This should be last because it can contain multiple lines
    `${commitMessageKey}=%B`,
  ].join('%n');

  const { stdout } = await getExecOutput(
    'git',
    ['show', sha, '--quiet', `--format=${logFormat}`],
    {
      silent: true,
    },
  );
  const lines = stdout.split('\n');

  const data: Record<string, string> = {};

  while (lines.length) {
    const line = lines.shift();
    if (!line) {
      break;
    }

    // Split on the first =
    const idx = line.indexOf('=');
    const [key, value] = [line.slice(0, idx), line.slice(idx + 1)];

    if (key === commitMessageKey) {
      // Once we've reached the commit message key, the remaining lines are the commit message.
      // We only keep the first line of the commit message, though, since some commit
      // messages can be very long.
      data[commitMessageKey] = value;
      break;
    }

    data[key] = value;
  }

  return zCommitSchema.parse(data);
}

export async function makeCIContext(): Promise<CIContext> {
  const env = zGitHubEnvSchema.parse(process.env);
  const commit = await parseCommitFromGitLog(env.GITHUB_SHA);
  const api = github.getOctokit(env.GITHUB_TOKEN);

  // GitHub Actions are triggered by webhook events, and the event payload is
  // stored in a JSON file at $GITHUB_EVENT_PATH.
  // You can see the schema of the various webhook payloads at:
  // https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads
  const event = JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH, 'utf-8'));

  const repository = repositoryFromEvent(event.repository);
  const pullRequest = pullRequestFromEvent(event.pull_request);

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
    commitSha: commit.sha,
    commitMessage: commit.message,
    commitCommitterName: commit.committerName,
    commitCommitterEmail: commit.committerEmail,
    commitAuthorName: commit.authorName,
    commitAuthorEmail: commit.authorEmail,
    commitCommittedDate: commit.committedDate,
    pullRequestNumber: pullRequest?.number ?? null,
    pullRequestTitle: pullRequest?.title || null,
  };
}
