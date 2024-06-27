import type { CIContext } from './ci';
import { makeTestRunStatusFromEvaluations } from './evals';
import {
  type Evaluation,
  EvaluationPassed,
  TestRunStatus,
  type TestRun,
} from './models';
import { makeAutoblocksCIBuildSummaryHtmlUrl } from './url';
import github from '@actions/github';
import _ from 'lodash';

// Commit messages are truncated if they're longer than this
const MAX_COMMIT_MESSAGE_LENGTH = 50;

// Header names for the evaluators + test cases "table"
const EVALUATOR_HEADER_NAME = 'Evaluators';
const TEST_CASES_HEADER_NAME = 'Test Cases';

// The number of spaces between the evaluator name column
// and the test case stats column
const COLUMN_GAP = ' '.repeat(4);

const GITHUB_COMMENT_BANNER_IMAGE =
  'https://github.com/autoblocksai/cli/assets/7498009/53f0af0b-8ffd-4c95-8dbf-c96051ed5568';

const statusToIcon: Record<TestRunStatus, string> = {
  [TestRunStatus.PASSED]: '✓',
  [TestRunStatus.FAILED]: '✗',
  [TestRunStatus.NO_RESULTS]: '?',
};

const statusToLabel: Record<TestRunStatus, string> = {
  [TestRunStatus.PASSED]: 'PASSED',
  [TestRunStatus.FAILED]: 'FAILED',
  [TestRunStatus.NO_RESULTS]: 'NO RESULTS',
};

export async function postSlackMessage(args: {
  webhookUrl: string;
  branchId: string;
  buildId: string;
  ciContext: CIContext;
  runDurationMs: number;
  runs: TestRun[];
  evaluations: Evaluation[];
}) {
  const resp = await fetch(args.webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(makeSlackMessageBlocks(args)),
  });
  if (!resp.ok) {
    const data = await resp.text();
    throw new Error(`HTTP Request Error: ${data}`);
  }
}

async function findExistingCommentIdOnCommit(args: {
  githubToken: string;
  commitSha: string;
  workflowName: string;
  jobName: string;
}): Promise<number | null> {
  const api = github.getOctokit(args.githubToken);
  for await (const response of api.paginate.iterator(
    'GET /repos/{owner}/{repo}/commits/{commit_sha}/comments',
    {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      commit_sha: args.commitSha,
    },
  )) {
    for (const comment of response.data) {
      if (
        comment.body.includes(
          autoblocksGitHubCommentId({
            workflowName: args.workflowName,
            jobName: args.jobName,
          }),
        )
      ) {
        return comment.id;
      }
    }
  }

  return null;
}

async function findExistingCommentIdOnPullRequest(args: {
  githubToken: string;
  pullRequestNumber: number;
  workflowName: string;
  jobName: string;
}): Promise<number | null> {
  const api = github.getOctokit(args.githubToken);
  for await (const response of api.paginate.iterator(
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
    {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: args.pullRequestNumber,
    },
  )) {
    for (const comment of response.data) {
      if (
        comment.body?.includes(
          autoblocksGitHubCommentId({
            workflowName: args.workflowName,
            jobName: args.jobName,
          }),
        )
      ) {
        return comment.id;
      }
    }
  }

  return null;
}

export async function postGitHubComment(args: {
  githubToken: string;
  branchId: string;
  buildId: string;
  ciContext: CIContext;
  runDurationMs: number;
  runs: TestRun[];
  evaluations: Evaluation[];
}) {
  const api = github.getOctokit(args.githubToken);
  const comment = makeGitHubComment(args);

  // Comment on the pull request if there is an associated pull request number
  // and we're not on the default branch
  if (
    args.ciContext.pullRequestNumber !== null &&
    !args.ciContext.isDefaultBranch
  ) {
    // Check if there is an existing comment on the PR
    const existingCommentId = await findExistingCommentIdOnPullRequest({
      githubToken: args.githubToken,
      pullRequestNumber: args.ciContext.pullRequestNumber,
      workflowName: args.ciContext.workflowName,
      jobName: args.ciContext.jobName,
    });
    if (existingCommentId !== null) {
      // Update the existing comment on the PR
      try {
        await api.rest.issues.updateComment({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          comment_id: existingCommentId,
          body: comment,
        });
        return;
      } catch {
        // This will fail if we don't have permission to comment on PRs,
        // so we'll continue to commenting on the commit instead
      }
    } else {
      // Create a new comment on the PR
      try {
        await api.rest.issues.createComment({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          issue_number: args.ciContext.pullRequestNumber,
          body: comment,
        });
        return;
      } catch {
        // This will fail if we don't have permission to comment on PRs,
        // so we'll continue to commenting on the commit instead
      }
    }
  }
  const existingCommentId = await findExistingCommentIdOnCommit({
    githubToken: args.githubToken,
    commitSha: args.ciContext.commitSha,
    workflowName: args.ciContext.workflowName,
    jobName: args.ciContext.jobName,
  });
  if (existingCommentId !== null) {
    // Update the existing comment on the commit
    await api.rest.repos.updateCommitComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      comment_id: existingCommentId,
      body: comment,
    });
    return;
  } else {
    // Create a new comment on the commit
    await api.rest.repos.createCommitComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      commit_sha: args.ciContext.commitSha,
      body: comment,
    });
  }
}

/**
 * Used to identify comments made by us.
 *
 * Assumes users only run one `npx autoblocks testing exec` command per workflow job.
 */
function autoblocksGitHubCommentId(args: {
  workflowName: string;
  jobName: string;
}): string {
  return `<!--- autoblocks-${args.workflowName}-${args.jobName} -->`;
}

function makeGitHubComment(args: {
  branchId: string;
  buildId: string;
  ciContext: CIContext;
  runDurationMs: number;
  runs: TestRun[];
  evaluations: Evaluation[];
}): string {
  const autoblocksUrl = makeAutoblocksCIBuildSummaryHtmlUrl({
    branchId: args.branchId,
    buildId: args.buildId,
  });
  const status = makeTestRunStatusFromEvaluations(args.evaluations);
  const statusIcon = statusToIcon[status];
  const statusLabel = statusToLabel[status];
  const duration = makeDurationString(args.runDurationMs);
  const buildName = makeBuildName({
    workflowName: args.ciContext.workflowName,
    workflowRunNumber: args.ciContext.workflowRunNumber,
    jobName: args.ciContext.jobName,
  });
  const buildUrl = args.ciContext.buildHtmlUrl;

  const statusHeaders = [
    `${statusIcon} <code>${statusLabel}</code>`,
    `🕐 ${duration}`,
    `🏗️ <a href="${buildUrl}">${buildName}</a>`,
    `➡️ <a href="${autoblocksUrl}">View in Autoblocks</a>`,
  ].join('&nbsp;&nbsp;•&nbsp;&nbsp;');

  const lines = [
    `<p align="center"><img src="${GITHUB_COMMENT_BANNER_IMAGE}" width="100%"></p>`,
    `<p align="center">${statusHeaders}</p>`,
    '',
    '---',
    '',
  ];

  // Note we don't share this with the Slack emoji map because Slack calls
  // it :large_green_circle: instead of :green_circle: 🙃
  const statusToEmoji: Record<TestRunStatus, string> = {
    [TestRunStatus.PASSED]: ':green_circle:',
    [TestRunStatus.FAILED]: ':red_circle:',
    [TestRunStatus.NO_RESULTS]: ':grey_question:',
  };

  for (const run of sortedRuns(args.runs)) {
    const evaluations = args.evaluations.filter((e) => e.runId === run.runId);
    const emoji = statusToEmoji[makeTestRunStatusFromEvaluations(evaluations)];
    let title = `${emoji}&nbsp;&nbsp;**${run.testExternalId}**`;

    if (run.gridSearchParamsCombo) {
      title +=
        '&nbsp;&nbsp;&nbsp;&nbsp;' +
        Object.entries(run.gridSearchParamsCombo)
          .map(([key, value]) => {
            return `${key} = **${JSON.stringify(value)}**`;
          })
          .join('&nbsp;&nbsp;');
    }
    lines.push(title);
    lines.push('```');
    lines.push(makeEvaluatorStatsTable({ evaluations }));
    lines.push('```');
  }

  lines.push(
    `<p align="right">Generated by <a href="https://www.autoblocks.ai/">Autoblocks</a> against ${args.ciContext.commitSha}</p>`,
  );
  lines.push(
    autoblocksGitHubCommentId({
      workflowName: args.ciContext.workflowName,
      jobName: args.ciContext.jobName,
    }),
  );

  return lines.join('\n');
}

function makeSlackMessageBlocks(args: {
  branchId: string;
  buildId: string;
  ciContext: CIContext;
  runDurationMs: number;
  runs: TestRun[];
  evaluations: Evaluation[];
}) {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Autoblocks Test Run*',
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View in Autoblocks',
            emoji: true,
          },
          url: makeAutoblocksCIBuildSummaryHtmlUrl({
            branchId: args.branchId,
            buildId: args.buildId,
          }),
        },
      },
      makeStatusHeaderSection({
        ciContext: args.ciContext,
        runDurationMs: args.runDurationMs,
        evaluations: args.evaluations,
      }),
      {
        type: 'divider',
      },
      ...makeAllTestRunSections({
        runs: args.runs,
        evaluations: args.evaluations,
      }),
    ],
  };
}

function makeDurationString(durationMs: number): string {
  const durationSeconds = durationMs / 1000;
  const durationMinutes = durationSeconds / 60;

  if (durationMinutes < 1) {
    return `${Math.floor(durationSeconds)}s`;
  }

  return `${Math.floor(durationMinutes)}m ${Math.floor(durationSeconds % 60)}s`;
}

function makeBuildName(args: {
  workflowName: string;
  workflowRunNumber: number;
  jobName: string;
}): string {
  return `${args.workflowName} / ${args.jobName} (#${args.workflowRunNumber})`;
}

function sortedRuns(runs: TestRun[]): TestRun[] {
  // Sort by test ID so that runs from the same test suite are grouped together
  return _.sortBy(runs, (r) => `${r.testExternalId}-${r.startedAt}`);
}

function makeStatusHeaderSection(args: {
  ciContext: CIContext;
  runDurationMs: number;
  evaluations: Evaluation[];
}) {
  const status = makeTestRunStatusFromEvaluations(args.evaluations);
  const statusIcon = statusToIcon[status];
  const statusLabel = statusToLabel[status];
  const duration = makeDurationString(args.runDurationMs);
  const buildName = makeBuildName({
    workflowName: args.ciContext.workflowName,
    workflowRunNumber: args.ciContext.workflowRunNumber,
    jobName: args.ciContext.jobName,
  });
  const commitUrl = `${args.ciContext.repoHtmlUrl}/commit/${args.ciContext.commitSha}`;
  const truncatedCommitMessage =
    args.ciContext.commitMessage.length > MAX_COMMIT_MESSAGE_LENGTH
      ? `${args.ciContext.commitMessage.slice(0, MAX_COMMIT_MESSAGE_LENGTH)}...`
      : args.ciContext.commitMessage;
  const truncatedCommitSha = args.ciContext.commitSha.slice(0, 7);

  return {
    type: 'section',
    fields: [
      {
        type: 'mrkdwn',
        text: `*Status:*\n${statusIcon}  \`${statusLabel}\``,
      },
      {
        type: 'mrkdwn',
        text: `*Duration:*\n${duration}`,
      },
      {
        type: 'mrkdwn',
        text: `*Build:*\n<${args.ciContext.buildHtmlUrl}|${buildName}>`,
      },
      {
        type: 'mrkdwn',
        text: `*Commit:*\n<${commitUrl}|${truncatedCommitSha}> ${truncatedCommitMessage}`,
      },
    ],
  };
}

function makeAllTestRunSections(args: {
  runs: TestRun[];
  evaluations: Evaluation[];
}) {
  return sortedRuns(args.runs).flatMap((run) => {
    const evaluations = args.evaluations.filter((e) => e.runId === run.runId);
    return makeSectionsForTestRun({ run, evaluations });
  });
}

function makeSectionsForTestRun(args: {
  run: TestRun;
  // These evaluations have already been filtered to only include the ones
  // belonging to this test run
  evaluations: Evaluation[];
}) {
  const statusToEmoji: Record<TestRunStatus, string> = {
    // For some reason green is large_green_circle
    // instead of just green_circle
    [TestRunStatus.PASSED]: ':large_green_circle:',
    [TestRunStatus.FAILED]: ':red_circle:',
    [TestRunStatus.NO_RESULTS]: ':grey_question:',
  };

  const status = makeTestRunStatusFromEvaluations(args.evaluations);
  const statusEmoji = statusToEmoji[status];

  const sections: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${statusEmoji} ${args.run.testExternalId}`,
        emoji: true,
      },
    },
  ];

  if (args.run.gridSearchParamsCombo) {
    sections.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`${Object.entries(args.run.gridSearchParamsCombo)
          .map(([key, value]) => {
            return `${key} = ${JSON.stringify(value)}`;
          })
          .join(' '.repeat(2))}\``,
      },
    });
  }

  sections.push({
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_preformatted',
        elements: [
          {
            type: 'text',
            text: makeEvaluatorStatsTable({ evaluations: args.evaluations }),
          },
        ],
      },
    ],
  });

  return sections;
}

/**
 * Make a table of the evaluator stats. For example:
 *
 * Evaluators             Test Cases
 * -------------------------------------------------------------
 * has-all-substrings      979 PASSED    121 FAILED    0 SKIPPED
 * is-friendly           1,000 PASSED      0 FAILED    0 SKIPPED
 */
function makeEvaluatorStatsTable(args: { evaluations: Evaluation[] }): string {
  // Get the evaluator IDs sorted alphabetically
  const evaluatorIds = [
    ...new Set(args.evaluations.map((e) => e.evaluatorExternalId)),
  ].sort();

  // Get the evaluator with the longest name
  // This is used to align the test case stats evenly to the RHS of the evaluator name column
  const maxEvaluatorIdLength = Math.max(
    ...evaluatorIds.map((evaluatorId) => evaluatorId.length),
  );

  const uniqTestCaseHashes = [
    ...new Set(args.evaluations.map((e) => e.testCaseHash)),
  ];

  // Get the number of passed / failed / skipped test cases per evaluator
  const evaluatorStats: Record<
    string,
    {
      numPassedString: string;
      numFailedString: string;
      numSkippedString: string;
    }
  > = {};
  for (const evaluatorId of evaluatorIds) {
    const evaluations = args.evaluations.filter(
      (e) => e.evaluatorExternalId === evaluatorId,
    );

    const passedCount = evaluations.filter(
      (e) => e.passed === EvaluationPassed.TRUE,
    ).length;
    const failedCount = evaluations.filter(
      (e) => e.passed === EvaluationPassed.FALSE,
    ).length;
    const naCount = evaluations.filter(
      (e) => e.passed === EvaluationPassed.NOT_APPLICABLE,
    ).length;

    // Find the # of test cases that don't have an evaluation for this evaluator
    const skippedCount = uniqTestCaseHashes.filter(
      (hash) => !evaluations.some((e) => e.testCaseHash === hash),
    ).length;

    evaluatorStats[evaluatorId] = {
      // Consider N/A as passed to simplify
      numPassedString: (passedCount + naCount).toLocaleString(),
      numFailedString: failedCount.toLocaleString(),
      numSkippedString: skippedCount.toLocaleString(),
    };
  }

  // Get the max length of each of the numPassed, numFailed, and numSkipped strings.
  // This is used to right-align the numbers in each column (passed / failed / skipped).
  const maxNumPassedLength = Math.max(
    ...Object.values(evaluatorStats).map((s) => s.numPassedString.length),
  );
  const maxNumFailedLength = Math.max(
    ...Object.values(evaluatorStats).map((s) => s.numFailedString.length),
  );
  const maxNumSkippedLength = Math.max(
    ...Object.values(evaluatorStats).map((s) => s.numSkippedString.length),
  );

  // Add the header row
  const paddedEvaluatorHeader =
    EVALUATOR_HEADER_NAME.padEnd(maxEvaluatorIdLength);
  const rows: string[] = [
    `${paddedEvaluatorHeader}${COLUMN_GAP}${TEST_CASES_HEADER_NAME}`,
  ];

  // Add the evaluator stats rows
  evaluatorIds.forEach((evaluatorId) => {
    const stats = evaluatorStats[evaluatorId];
    const statsAsString = makeEvaluatorStatsRow({
      numPassedString: stats.numPassedString,
      numFailedString: stats.numFailedString,
      numSkippedString: stats.numSkippedString,
      maxNumPassedLength,
      maxNumFailedLength,
      maxNumSkippedLength,
    });

    const paddedEvaluatorId = evaluatorId.padEnd(maxEvaluatorIdLength);
    rows.push(`${paddedEvaluatorId}${COLUMN_GAP}${statsAsString}`);
  });

  // Add the separator row. Should be as long as the longest row so far
  const maxRowLength = Math.max(...rows.map((r) => r.length));
  const separatorRow = '-'.repeat(maxRowLength);
  rows.splice(1, 0, separatorRow);

  return rows.join('\n') + '\n';
}

/**
 * Make a row for the given evaluator stats.
 * Numbers should be right-justified for their column.
 * For example:
 *
 *       3 PASSED    56 FAILED    0 SKIPPED
 *   1,000 PASSED     6 FAILED    0 SKIPPED
 */
function makeEvaluatorStatsRow(args: {
  numPassedString: string;
  numFailedString: string;
  numSkippedString: string;
  maxNumPassedLength: number;
  maxNumFailedLength: number;
  maxNumSkippedLength: number;
}): string {
  const paddedNumPassed = args.numPassedString.padStart(
    args.maxNumPassedLength,
  );
  const paddedNumFailed = args.numFailedString.padStart(
    args.maxNumFailedLength,
  );
  const paddedNumSkipped = args.numSkippedString.padStart(
    args.maxNumSkippedLength,
  );

  return [
    `${paddedNumPassed} PASSED`,
    `${paddedNumFailed} FAILED`,
    `${paddedNumSkipped} SKIPPED`,
  ].join(COLUMN_GAP);
}
