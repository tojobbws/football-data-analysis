/**
 * Hourly data-sync trigger. GitHub's own `schedule` for the hourly sync fired only every 4–7 hours,
 * so this Worker's cron (on time) starts the workflow through `workflow_dispatch` instead.
 */
export const HOURLY_CRON = '5 * * * *';

export interface DispatchOptions {
  /** fine-grained token with Actions: write on the repo */
  token: string;
  /** owner/name */
  repo: string;
  workflow?: string;
  job?: string;
  ref?: string;
  fetchImpl?: typeof fetch;
}

export async function dispatchWorkflow(opts: DispatchOptions): Promise<void> {
  const { token, repo, workflow = 'sync.yml', job = 'hourly', ref = 'main', fetchImpl = fetch } = opts;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'football-live-score',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref, inputs: { job } }),
  });
  if (res.status !== 204) throw new Error(`workflow_dispatch ${workflow} (${job}) failed: ${res.status} ${await res.text()}`);
}
