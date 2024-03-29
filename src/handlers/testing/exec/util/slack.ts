import { CIContext } from './ci';
import { makeTestRunStatusFromEvaluations } from './evals';
import { Evaluation, TestRunStatus } from './models';

// Commit messages are truncated if they're longer than this
const MAX_COMMIT_MESSAGE_LENGTH = 50;

// Header names for the evaluators + test cases "table"
const EVALUATOR_HEADER_NAME = 'Evaluators';
const TEST_CASES_HEADER_NAME = 'Test Cases';

// The number of spaces between the evaluator name column
// and the test case stats column
const COLUMN_GAP = ' '.repeat(4);

export async function postSlackMessage(args: {
  webhookUrl: string;
  branchId: string;
  buildId: string;
  ciContext: CIContext;
  runDurationMs: number;
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

function makeSlackMessageBlocks(args: {
  branchId: string;
  buildId: string;
  ciContext: CIContext;
  runDurationMs: number;
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
          url: makeLinkToBuildInAutoblocks({
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
      ...makeAllTestSuiteSections({ evaluations: args.evaluations }),
    ],
  };
}

function makeLinkToBuildInAutoblocks(args: {
  branchId: string;
  buildId: string;
}): string {
  return `https://app.autoblocks.ai/testing/ci?branchId=${args.branchId}&buildId=${args.buildId}`;
}

function makeDurationString(durationMs: number): string {
  const durationSeconds = durationMs / 1000;
  const durationMinutes = durationSeconds / 60;

  if (durationMinutes < 1) {
    return `${Math.floor(durationSeconds)}s`;
  }

  return `${Math.floor(durationMinutes)}m ${Math.floor(durationSeconds % 60)}s`;
}

function makeStatusHeaderSection(args: {
  ciContext: CIContext;
  runDurationMs: number;
  evaluations: Evaluation[];
}) {
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

  const status = makeTestRunStatusFromEvaluations(args.evaluations);
  const statusIcon = statusToIcon[status];
  const statusLabel = statusToLabel[status];
  const duration = makeDurationString(args.runDurationMs);
  const buildName = `${args.ciContext.workflowName} #${args.ciContext.workflowRunNumber}`;
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
        text: `*Commit:*\n<${commitUrl}|${truncatedCommitSha}>  ${truncatedCommitMessage}`,
      },
    ],
  };
}

function makeAllTestSuiteSections(args: { evaluations: Evaluation[] }) {
  const uniqTestExternalIds = [
    ...new Set(args.evaluations.map((e) => e.testExternalId)),
  ].sort();
  return uniqTestExternalIds.flatMap((testExternalId) => {
    const evaluations = args.evaluations.filter(
      (e) => e.testExternalId === testExternalId,
    );
    return makeSectionsForTestSuite({ testExternalId, evaluations });
  });
}

function makeSectionsForTestSuite(args: {
  testExternalId: string;
  // These evaluations have already been filtered to only include the ones
  // belonging to this test suite
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

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${statusEmoji} ${args.testExternalId}`,
        emoji: true,
      },
    },
    {
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
    },
  ];
}

/**
 * Make a table of the evaluator stats. For example:
 *
 * Evaluators             Test Cases
 * -----------------------------------------------
 * has-all-substrings      979 PASSED | 121 FAILED
 * is-friendly           1,000 PASSED |   0 FAILED
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

  // Get the number of passed / failed test cases per evaluator
  const evaluatorStats: Record<
    string,
    { numPassedString: string; numFailedString: string }
  > = {};
  for (const evaluatorId of evaluatorIds) {
    const evaluations = args.evaluations.filter(
      (e) => e.evaluatorExternalId === evaluatorId,
    );

    const passedCount = evaluations.filter((e) => e.passed === true).length;
    const failedCount = evaluations.filter((e) => e.passed === false).length;
    const nullCount = evaluations.filter((e) => e.passed === null).length;

    evaluatorStats[evaluatorId] = {
      // Consider N/A as passed to simplify
      numPassedString: (passedCount + nullCount).toLocaleString(),
      numFailedString: failedCount.toLocaleString(),
    };
  }

  // Get the max length of each of the numPassed and numFailed strings
  // This is used to right-align the numbers in each column (passed / failed)
  const maxNumPassedLength = Math.max(
    ...Object.values(evaluatorStats).map((s) => s.numPassedString.length),
  );
  const maxNumFailedLength = Math.max(
    ...Object.values(evaluatorStats).map((s) => s.numFailedString.length),
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
      maxNumPassedLength,
      maxNumFailedLength,
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
 *       3 PASSED     56 FAILED
 *   1,000 PASSED      6 FAILED
 */
function makeEvaluatorStatsRow(args: {
  numPassedString: string;
  numFailedString: string;
  maxNumPassedLength: number;
  maxNumFailedLength: number;
}): string {
  const paddedNumPassed = args.numPassedString.padStart(
    args.maxNumPassedLength,
  );
  const paddedNumFailed = args.numFailedString.padStart(
    args.maxNumFailedLength,
  );

  return [`${paddedNumPassed} PASSED`, `${paddedNumFailed} FAILED`].join(
    ' '.repeat(5),
  );
}
