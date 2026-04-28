import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Agent, Box } from "@upstash/box";
import { z } from "zod";

const execFileAsync = promisify(execFile);

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

    const issueResult = await createGithubIssueWithOne({
      title: `[BoxFixer Request] ${data.title}`,
      body: requestIssueBody,
      owner: githubOwner,
      repo: githubRepoName,
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
          issueResult,
        }),
      };
    }

    const box = await Box.create({
      runtime: "node",
      agent: {
        harness: Agent.ClaudeCode,
        model: boxAgentModel,
      },
    });

    try {
      const prompt = [
        "You are an autonomous maintainer for this website repository.",
        "Plan and produce the exact code changes needed for the request.",
        `Target repository: ${normalizedRepo}`,
        `Base branch: ${githubTargetBranch}`,
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

async function createGithubIssueWithOne({ title, body, owner, repo, connectionKey }) {
  const actionId = await resolveGithubCreateIssueActionId();

  const result = await runOneCli([
    "actions",
    "execute",
    "github",
    actionId,
    connectionKey,
    "-d",
    JSON.stringify({ title, body, owner, repo }),
  ]);

  if (result?.error) {
    throw new Error(typeof result.error === "string" ? result.error : "One CLI action execution failed");
  }

  return result;
}

async function resolveGithubCreateIssueActionId() {
  const searchResult = await runOneCli([
    "actions",
    "search",
    "github",
    "create issue",
    "-t",
    "execute",
  ]);

  if (searchResult?.error) {
    throw new Error(typeof searchResult.error === "string" ? searchResult.error : "One CLI action search failed");
  }

  const actionId = extractActionId(searchResult);
  if (!actionId) {
    throw new Error("Unable to resolve GitHub create-issue action ID from One CLI search results");
  }

  return actionId;
}

function extractActionId(payload) {
  if (!payload) {
    return null;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractActionId(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof payload === "object") {
    if (typeof payload.actionId === "string") {
      return payload.actionId;
    }
    if (typeof payload.id === "string") {
      return payload.id;
    }

    for (const key of ["actions", "results", "items", "data"]) {
      const found = extractActionId(payload[key]);
      if (found) {
        return found;
      }
    }

    for (const value of Object.values(payload)) {
      if (typeof value === "object" && value !== null) {
        const found = extractActionId(value);
        if (found) {
          return found;
        }
      }
    }
  }

  return null;
}

async function runOneCli(args) {
  const fullArgs = ["--agent", ...args];
  const execOptions = {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      HOME: process.env.HOME || "/tmp",
    },
  };

  const attempts = [
    { cmd: "one", argv: fullArgs },
    { cmd: "./node_modules/.bin/one", argv: fullArgs },
    { cmd: "node_modules/.bin/one", argv: fullArgs },
    { cmd: `${process.cwd()}/node_modules/.bin/one`, argv: fullArgs },
    { cmd: "/var/task/node_modules/.bin/one", argv: fullArgs },
    { cmd: "npx", argv: ["--no-install", "one", ...fullArgs] },
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const result = await execFileAsync(attempt.cmd, attempt.argv, execOptions);
      return parseCliStdout(result.stdout);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Failed to execute One CLI");
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

  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1];

  try {
    return JSON.parse(lastLine);
  } catch {
    return { raw: trimmed };
  }
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
