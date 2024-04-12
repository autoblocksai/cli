import { AUTOBLOCKS_WEBAPP_BASE_URL } from '../../../../util/constants';

export function makeAutoblocksCIBuildHtmlUrl(args: {
  branchId: string;
  buildId: string;
}): string {
  return `${AUTOBLOCKS_WEBAPP_BASE_URL}/testing/ci?branchId=${args.branchId}&buildId=${args.buildId}`;
}

export function makeAutoblocksTestHtmlUrl(args: {
  testExternalId: string;
}): string {
  const subpath = process.env.CI ? 'ci' : 'local';
  return `${AUTOBLOCKS_WEBAPP_BASE_URL}/testing/${subpath}/test/${encodeURIComponent(args.testExternalId)}`;
}
