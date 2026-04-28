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

      const actionId = await resolveGithubCreateIssueActionIdInBox({
        box,
        oneApiKey,
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
            issueResult,
          }),
        };
      }

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

async function ensureOneCliInstalled(box, oneApiKey) {
  await box.exec.command(
    `${buildOneEnv(oneApiKey)} sh -c ${shellQuote("mkdir -p /tmp/one-cli /tmp/box-home /tmp/.npm-cache && (command -v one >/dev/null 2>&1 || npm install -g @withone/cli) && one --agent list")}`,
  );
}

async function resolveGithubCreateIssueActionIdInBox({ box, oneApiKey }) {
  const command = `${buildOneEnv(oneApiKey)} one --agent actions search github ${shellQuote("create issue")} -t execute`;
  const result = await box.exec.command(command);
  const parsed = parseCliStdout(extractCommandStdout(result));

  if (parsed?.error) {
    throw new Error(typeof parsed.error === "string" ? parsed.error : "One CLI action search failed");
  }

  const actionId = extractActionId(parsed);
  if (!actionId) {
    const raw = typeof parsed?.raw === "string" ? parsed.raw : JSON.stringify(parsed);
    const snippet = String(raw || "").slice(0, 600);
    throw new Error(`Unable to resolve GitHub create-issue action ID from One CLI search results. Output: ${snippet}`);
  }

  return actionId;
}

async function createGithubIssueWithOneInBox({ box, oneApiKey, title, body, owner, repo, actionId, connectionKey }) {
  const payload = JSON.stringify({ title, body, owner, repo });
  const command = `${buildOneEnv(oneApiKey)} one --agent actions execute github ${shellQuote(actionId)} ${shellQuote(connectionKey)} -d ${shellQuote(payload)}`;
  const result = await box.exec.command(command);
  const parsed = parseCliStdout(extractCommandStdout(result));

  if (parsed?.error) {
    throw new Error(typeof parsed.error === "string" ? parsed.error : "One CLI action execution failed");
  }

  return parsed;
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

function extractActionId(payload) {
  if (!payload) {
    return null;
  }

  if (typeof payload === "string") {
    return extractActionIdFromText(payload);
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
    if (typeof payload.action_id === "string") {
      return payload.action_id;
    }
    if (typeof payload.id === "string") {
      return payload.id;
    }
    if (typeof payload.actionKey === "string") {
      return payload.actionKey;
    }
    if (typeof payload.key === "string") {
      return payload.key;
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

function extractActionIdFromText(text) {
  const patterns = [
    /"actionId"\s*:\s*"([^"]+)"/i,
    /"action_id"\s*:\s*"([^"]+)"/i,
    /"actionKey"\s*:\s*"([^"]+)"/i,
    /"key"\s*:\s*"([^"]+)"/i,
    /\b([a-z0-9._-]*create[a-z0-9._-]*issue[a-z0-9._-]*)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
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
