import { AUTOBLOCKS_WEBAPP_BASE_URL } from '../../../../util/constants';

/**
 * Links to the summary dashboard for all tests for a given branch + build.
 */
export function makeAutoblocksCIBuildSummaryHtmlUrl(args: {
  branchId: string;
  buildId: string;
}): string {
  const branchId = encodeURIComponent(args.branchId);
  const buildId = encodeURIComponent(args.buildId);
  return `${AUTOBLOCKS_WEBAPP_BASE_URL}/regression?branchId=${branchId}&buildId=${buildId}`;
}

export function makeAutoblocksLocalTestResultsHtmlUrl(args: {
  testExternalId: string;
  runId: string;
}): string {
  const testId = encodeURIComponent(args.testExternalId);
  const runId = encodeURIComponent(args.runId);
  return `${AUTOBLOCKS_WEBAPP_BASE_URL}/experiments/${testId}/inspect-run?baselineRunId=${runId}`;
}

export function makeAutoblocksCITestResultsHtmlUrl(args: {
  testExternalId: string;
  branchId: string;
  runId: string;
}): string {
  const testId = encodeURIComponent(args.testExternalId);
  const branchId = encodeURIComponent(args.branchId);
  const runId = encodeURIComponent(args.runId);
  return `${AUTOBLOCKS_WEBAPP_BASE_URL}/regression/${testId}/branch/${branchId}/inspect-run?baselineRunId=${runId}`;
}

/**
 * Links to a group of runs from a grid search.
 */
export function makeAutoblocksGridSearchRunGroupHtmlUrl(args: {
  testExternalId: string;
  gridSearchRunGroupId: string;
}): string {
  const testId = encodeURIComponent(args.testExternalId);
  const gridId = encodeURIComponent(args.gridSearchRunGroupId);
  return `${AUTOBLOCKS_WEBAPP_BASE_URL}/testing/test/${testId}/grid/${gridId}`;
}
