import { AUTOBLOCKS_WEBAPP_BASE_URL } from '../../../../util/constants';

/**
 * Links to the summary dashboard for all tests for a given branch + build.
 */
export function makeAutoblocksCIBuildSummaryHtmlUrl(args: {
  branchId: string;
  buildId: string;
}): string {
  return `${AUTOBLOCKS_WEBAPP_BASE_URL}/testing/ci?branchId=${args.branchId}&buildId=${args.buildId}`;
}

export function makeAutoblocksLocalTestResultsHtmlUrl(args: {
  testExternalId: string;
}): string {
  return `${AUTOBLOCKS_WEBAPP_BASE_URL}/testing/local/test/${encodeURIComponent(args.testExternalId)}`;
}

export function makeAutoblocksCITestResultsHtmlUrl(args: {
  testExternalId: string;
  branchId: string;
}): string {
  const testId = encodeURIComponent(args.testExternalId);
  const branchId = encodeURIComponent(args.branchId);
  return `${AUTOBLOCKS_WEBAPP_BASE_URL}/testing/ci/test/${testId}/branch/${branchId}`;
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
