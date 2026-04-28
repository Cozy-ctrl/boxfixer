import { Agent, Box } from "@upstash/box";
import { z } from "zod";

const requestSchema = z.object({
  title: z.string().min(5).max(120),
  description: z.string().min(10).max(3000),
  email: z.string().email().optional(),
  sourceUrl: z.string().url().optional(),
});

const resultSchema = z.object({
  summary: z.string().max(2000).optional(),
  branch: z.string().max(200).optional(),
  prUrl: z.string().url().optional(),
});

const jsonHeaders = {
  "Content-Type": "application/json",
};

const githubOneActionIds = {
  createIssue: "conn_mod_def::GJ3ZOgmKVac::6mksPa9nTK-WqE9cw3w6sg",
  createPullRequest: "conn_mod_def::GJ3Zvwimv2M::OUXep-YSTTahrYwgTonbEQ",
  createOrUpdateFileContents: "conn_mod_def::GJ3Z6PMkkJs::JqZng63wRPmYE8noRt3IcA",
  createGitReference: "conn_mod_def::GJ3ZJzQSbw4::FMDSgh1WS5mvn2imiAkk2w",
  getGitReference: "conn_mod_def::GJ3ZKe5vDKs::xb13z7ZBRnOWekJ-N_TG3w",
  listBranches: "conn_mod_def::GJ3aGRCYx4M::Y-VXDk4uS0Cfq9VxPQ4y8Q",
  getPullRequest: "conn_mod_def::GJ3ZwtLhLF8::IXLUkrH2TNGXzoPNPM7PdA",
};

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const parsedBody = safeParseJson(event.body);
  if (!parsedBody.ok) {
    return {
      statusCode: 400,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const parsedRequest = requestSchema.safeParse(parsedBody.value);
  if (!parsedRequest.success) {
    return {
      statusCode: 400,
      headers: jsonHeaders,
      body: JSON.stringify({
        error: "Validation failed",
        issues: parsedRequest.error.flatten(),
      }),
    };
  }

  const boxApiKey = process.env.UPSTASH_BOX_API_KEY;
  const githubRepo = process.env.GITHUB_REPO;
  const githubTargetBranch = process.env.GITHUB_TARGET_BRANCH || "main";
  const boxAgentModel = process.env.BOX_AGENT_MODEL || "anthropic/claude-sonnet-4-5";
  const oneGithubConnectionKey = process.env.ONE_GITHUB_CONNECTION_KEY;
  const oneApiKey = process.env.ONE_API_KEY;
  const [githubOwner, githubRepoName] = parseOwnerRepo(githubRepo);
  const dryRun = process.env.BOXFIXER_DRY_RUN !== "false";

  if (!boxApiKey) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Missing UPSTASH_BOX_API_KEY env var" }),
    };
  }

  if (!githubRepo) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Missing GITHUB_REPO env var" }),
    };
  }

  if (!oneApiKey) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Missing ONE_API_KEY env var" }),
    };
  }

  if (!oneGithubConnectionKey) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Missing ONE_GITHUB_CONNECTION_KEY env var" }),
    };
  }

  if (!githubOwner || !githubRepoName) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({
        error: "Missing GITHUB_OWNER or GITHUB_REPO_NAME env var",
      }),
    };
  }

  try {
    const data = parsedRequest.data;
    const normalizedRepo = normalizeRepo(githubRepo);
    const requestIssueBody = [
      "A new website change request was submitted.",
      "",
      `Title: ${data.title}`,
      `Description: ${data.description}`,
      data.email ? `Requester email: ${data.email}` : "Requester email: not provided",
      data.sourceUrl ? `Source URL: ${data.sourceUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const box = await Box.create({
      runtime: "node",
      name: "netlify-box",
      agent: {
        harness: Agent.ClaudeCode,
        model: boxAgentModel,
      },
    });

    try {
      await ensureOneCliInstalled(box, oneApiKey);

      const actionId = githubOneActionIds.createIssue;

      const actionKnowledge = await getGithubActionKnowledgeInBox({
        box,
        oneApiKey,
        actionId,
      });

      const issueResult = await createGithubIssueWithOneInBox({
        box,
        oneApiKey,
        title: `[BoxFixer Request] ${data.title}`,
        body: requestIssueBody,
        owner: githubOwner,
        repo: githubRepoName,
        actionId,
        connectionKey: oneGithubConnectionKey,
      });

      if (dryRun) {
        return {
          statusCode: 202,
          headers: jsonHeaders,
          body: JSON.stringify({
            ok: true,
            dryRun: true,
            message: "Request accepted. Set BOXFIXER_DRY_RUN=false to run Box agent and push a PR.",
            plan: {
              repo: normalizedRepo,
              targetBranch: githubTargetBranch,
              request: {
                title: data.title,
                description: data.description,
              },
            },
            one: {
              actionId,
              knowledge: summarizeKnowledge(actionKnowledge),
            },
            issueResult,
          }),
        };
      }

      const prompt = [
        "You are an autonomous maintainer for this website repository.",
        "Plan and produce the exact code changes needed for the request.",
        `Target repository: ${normalizedRepo}`,
        `Base branch: ${githubTargetBranch}`,
        "Use One CLI for all GitHub operations. Do not use direct GitHub tokens.",
        `One GitHub connection key: ${oneGithubConnectionKey}`,
        `One action IDs: ${JSON.stringify(githubOneActionIds)}`,
        "Return a concise implementation summary.",
        "",
        `Change title: ${data.title}`,
        `Change details: ${data.description}`,
        data.email ? `Requester email: ${data.email}` : "Requester email: not provided",
        data.sourceUrl ? `Source URL: ${data.sourceUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const run = await box.agent.run({
        prompt,
        responseSchema: resultSchema,
      });

      return {
        statusCode: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          ok: true,
          dryRun: false,
          result: run.result,
          one: {
            actionId,
            knowledge: summarizeKnowledge(actionKnowledge),
          },
          issueResult,
        }),
      };
    } finally {
      await box.delete();
    }
  } catch (error) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({
        error: "Failed to process change request through Box",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
};

async function ensureOneCliInstalled(box, oneApiKey) {
  await box.exec.command(
    `${buildOneEnv(oneApiKey)} sh -c ${shellQuote("mkdir -p /tmp/one-cli /tmp/box-home /tmp/.npm-cache && (command -v one >/dev/null 2>&1 || npm install -g @withone/cli) && one --agent list")}`,
  );
}

async function createGithubIssueWithOneInBox({ box, oneApiKey, title, body, owner, repo, actionId, connectionKey }) {
  const pathVars = JSON.stringify({ owner, repo });
  const payload = JSON.stringify({ title, body });
  const command = `${buildOneEnv(oneApiKey)} one --agent actions execute github ${shellQuote(actionId)} ${shellQuote(connectionKey)} --path-vars ${shellQuote(pathVars)} -d ${shellQuote(payload)}`;
  const result = await box.exec.command(command);
  const parsed = parseCliStdout(extractCommandStdout(result));

  if (parsed?.error) {
    throw new Error(typeof parsed.error === "string" ? parsed.error : "One CLI action execution failed");
  }

  return parsed;
}

async function getGithubActionKnowledgeInBox({ box, oneApiKey, actionId }) {
  const command = `${buildOneEnv(oneApiKey)} one --agent actions knowledge github ${shellQuote(actionId)}`;
  const result = await box.exec.command(command);
  const parsed = parseCliStdout(extractCommandStdout(result));

  if (parsed?.error) {
    throw new Error(typeof parsed.error === "string" ? parsed.error : "One CLI action knowledge failed");
  }

  return parsed;
}

function summarizeKnowledge(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const summary = {};
  if (typeof payload.method === "string") {
    summary.method = payload.method;
  }
  if (typeof payload.path === "string") {
    summary.path = payload.path;
  }
  if (typeof payload.title === "string") {
    summary.title = payload.title;
  }
  if (payload._cache && typeof payload._cache === "object") {
    summary.cache = payload._cache;
  }
  if (typeof payload.knowledge === "string") {
    summary.knowledgePreview = payload.knowledge.slice(0, 220);
  }

  return summary;
}

function buildOneEnv(oneApiKey) {
  return `ONE_SECRET=${shellQuote(oneApiKey)} ONE_API_KEY=${shellQuote(oneApiKey)} HOME=/tmp/box-home NPM_CONFIG_PREFIX=/tmp/one-cli NPM_CONFIG_CACHE=/tmp/.npm-cache PATH=/tmp/one-cli/bin:$PATH`;
}

function extractCommandStdout(result) {
  if (!result || typeof result !== "object") {
    return "";
  }

  if (typeof result.stdout === "string") {
    return result.stdout;
  }

  if (typeof result.output === "string") {
    return result.output;
  }

  return "";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function normalizeRepo(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/^https?:\/\//, "").replace(/\.git$/, "");
  }
  return trimmed.replace(/^github\.com\//, "").replace(/\.git$/, "");
}

function parseOwnerRepo(repo) {
  if (!repo) {
    return [null, null];
  }

  const normalized = normalizeRepo(repo);
  const [owner, name] = normalized.split("/");
  if (!owner || !name) {
    return [null, null];
  }

  return [owner, name];
}

function parseCliStdout(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { raw: "" };
  }

  try {
    return JSON.parse(trimmed);
  } catch {}

  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = lines[i].trim();
    if (!candidate) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return { raw: trimmed };
}

function safeParseJson(value) {
  if (!value) {
    return { ok: false };
  }

  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}
