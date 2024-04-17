import { AUTOBLOCKS_WEBAPP_BASE_URL } from '../../../../util/constants';

export function makeAutoblocksCIBuildHtmlUrl(args: {
  branchId: string;
  buildId: string;
}): string {
  return `${AUTOBLOCKS_WEBAPP_BASE_URL}/testing/ci?branchId=${args.branchId}&buildId=${args.buildId}`;
}

export function makeAutoblocksLocalTestHtmlUrl(args: {
  testExternalId: string;
}): string {
  return `${AUTOBLOCKS_WEBAPP_BASE_URL}/testing/local/test/${encodeURIComponent(args.testExternalId)}`;
}
