import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import { exec, ExecException, ExecOptions } from 'child_process';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import nodeFetch from 'node-fetch';
import pLimit from 'p-limit';

interface ExecResult {
  err?: Error | undefined;
  stdout: string;
  stderr: string;
}

interface App {
  metadata: { name: string };
  spec: {
    source: {
      repoURL: string;
      path: string;
      targetRevision: string;
      kustomize: Object;
      helm: Object;
    };
  };
  status: {
    sync: {
      status: 'OutOfSync' | 'Synced';
    };
  };
}
const ARCH = process.env.ARCH || 'linux';
const githubToken = core.getInput('github-token');
core.info(githubToken);

const ARGOCD_SERVER_URL = core.getInput('argocd-server-url');
const ARGOCD_TOKEN = core.getInput('argocd-token');
const VERSION = core.getInput('argocd-version');
const EXTRA_CLI_ARGS = core.getInput('argocd-extra-cli-args');
const INSECURE = core.getInput('insecure');
const CONCURRENCY = core.getInput('concurrency');
const RETRY_COUNT = core.getInput('retry-count');
const RETRY_DELAY = core.getInput('retry-delay');

const octokit = github.getOctokit(githubToken);

async function execCommand(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const p = new Promise<ExecResult>(async (done, failed) => {
    exec(command, options, (err: ExecException | null, stdout: string, stderr: string): void => {
      const res: ExecResult = {
        stdout,
        stderr
      };
      if (err) {
        res.err = err;
        failed(res);
        return;
      }
      done(res);
    });
  });
  return await p;
}

function scrubSecrets(input: string): string {
  let output = input;
  const authTokenMatches = input.match(/--auth-token=([\w.\S]+)/);
  if (authTokenMatches) {
    output = output.replace(new RegExp(authTokenMatches[1], 'g'), '***');
  }
  return output;
}

async function setupArgoCDCommand(
  insecure: string
): Promise<(params: string) => Promise<ExecResult>> {
  const argoBinaryPath = 'bin/argo';
  await tc.downloadTool(
    `https://github.com/argoproj/argo-cd/releases/download/${VERSION}/argocd-${ARCH}-amd64`,
    argoBinaryPath
  );
  fs.chmodSync(path.join(argoBinaryPath), '755');

  // core.addPath(argoBinaryPath);

  return async (params: string) =>
    execCommand(
      `${argoBinaryPath} ${params} ${insecure} --auth-token=${ARGOCD_TOKEN} --server=${ARGOCD_SERVER_URL} ${EXTRA_CLI_ARGS}`
    );
}

async function getApps(): Promise<App[]> {
  const url = `https://${ARGOCD_SERVER_URL}/api/v1/applications?fields=items.metadata.name,items.spec.source.path,items.spec.source.repoURL,items.spec.source.targetRevision,items.spec.source.helm,items.spec.source.kustomize,items.status.sync.status`;
  core.info(`Fetching apps from: ${url}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let responseJson: any;
  try {
    const response = await nodeFetch(url, {
      method: 'GET',
      headers: { Cookie: `argocd.token=${ARGOCD_TOKEN}` }
    });
    responseJson = await response.json();
  } catch (e) {
    core.error(e);
  }

  return (responseJson.items as App[]).filter(app => {
    return (
      app.spec.source.repoURL.includes(
        `${github.context.repo.owner}/${github.context.repo.repo}`
      ) &&
      (app.spec.source.targetRevision === 'master' ||
        app.spec.source.targetRevision === 'main' ||
        app.spec.source.targetRevision === 'HEAD')
    );
  });
}

interface Diff {
  app: App;
  diff: string;
  error?: ExecResult;
}
async function postDiffComment(diffs: Diff[]): Promise<void> {
  const { owner, repo } = github.context.repo;
  const sha = github.context.payload.pull_request?.head?.sha;

  const commitLink = `https://github.com/${owner}/${repo}/pull/${github.context.issue.number}/commits/${sha}`;
  const shortCommitSha = String(sha).substr(0, 7);

  const diffOutput = diffs.map(
    ({ app, diff, error }) => `   
App: [\`${app.metadata.name}\`](https://${ARGOCD_SERVER_URL}/applications/${app.metadata.name}) 
YAML generation: ${error ? ' Error 🛑' : 'Success 🟢'}
App sync status: ${app.status.sync.status === 'Synced' ? 'Synced ✅' : 'Out of Sync ⚠️ '}
${
  error
    ? `
**\`stderr:\`**
\`\`\`
${error.stderr}
\`\`\`

**\`command:\`**
\`\`\`json
${JSON.stringify(error.err)}
\`\`\`
`
    : ''
}

${
  diff
    ? `
<details>

\`\`\`diff
${diff}
\`\`\`

</details>
`
    : ''
}
---
`
  );

  const output = scrubSecrets(`
## ArgoCD Diff for commit [\`${shortCommitSha}\`](${commitLink})
_Updated at ${new Date().toUTCString()}_
  ${diffOutput.join('\n')}

| Legend | Status |
| :---:  | :---   |
| ✅     | The app is synced in ArgoCD, and diffs you see are solely from this PR. |
| ⚠️      | The app is out-of-sync in ArgoCD, and the diffs you see include those changes plus any from this PR. |
| 🛑     | There was an error generating the ArgoCD diffs due to changes in this PR. |
`);

  const commentsResponse = await octokit.rest.issues.listComments({
    issue_number: github.context.issue.number,
    owner,
    repo
  });

  const existingComment = commentsResponse.data.find(d => d.body!.includes('ArgoCD Diff for'));

  // Existing comments should be updated even if there are no changes this round in order to indicate that
  if (existingComment) {
    octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body: output
    });
    // Only post a new comment when there are changes
  } else if (diffs.length) {
    octokit.rest.issues.createComment({
      issue_number: github.context.issue.number,
      owner,
      repo,
      body: output
    });
  }
}

async function run(): Promise<void> {
  let argoInsecure = '';
  if (INSECURE === 'true') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    argoInsecure = '--insecure';
  }
  const apps = await getApps();
  core.info(`Found apps: ${apps.map(a => a.metadata.name).join(', ')}`);

  const argocd = await setupArgoCDCommand(argoInsecure);

  const limit = pLimit(Number(CONCURRENCY));

  let diffs: Diff[] = [];
  const input: Promise<void>[] = [];
  apps.forEach(app => {
    input.push(
      limit(async () => {
        const command = `app diff ${app.metadata.name} --revision=${github.context.payload.pull_request?.head?.sha}`;

        for (let retry = 0; retry < Number(RETRY_COUNT); retry++) {
          try {
            core.info(`Running (${retry + 1}/${RETRY_COUNT}): argocd ${command}`);
            // ArgoCD app diff will exit 1 if there is a diff, so always catch,
            // and then consider it a success if there's a diff in stdout
            // https://github.com/argoproj/argo-cd/issues/3588
            await argocd(command);
            break;
          } catch (e) {
            const res = e as ExecResult;
            core.info(`stdout (${app.metadata.name}): ${res.stdout}`);
            core.info(`stderr (${app.metadata.name}): ${res.stderr}`);
            if (res.stdout) {
              diffs.push({ app, diff: res.stdout });
              break;
            } else {
              await new Promise(f => setTimeout(f, Number(RETRY_DELAY)));
              if (retry + 1 === Number(RETRY_COUNT)) {
                diffs.push({
                  app,
                  diff: '',
                  error: e
                });
              }
            }
          }
        }
      })
    );
  });

  await Promise.all(input);

  diffs = diffs.sort((a, b) => a.app.metadata.name.localeCompare(b.app.metadata.name));

  await postDiffComment(diffs);
  const diffsWithErrors = diffs.filter(d => d.error);
  if (diffsWithErrors.length) {
    core.setFailed(`ArgoCD diff failed: Encountered ${diffsWithErrors.length} errors`);
  }
}

run().catch(e => core.setFailed(e.message));
