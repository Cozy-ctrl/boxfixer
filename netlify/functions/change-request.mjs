import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const requestSchema = z.object({
  title: z.string().min(5).max(120),
  description: z.string().min(10).max(3000),
  email: z.string().email().optional(),
  sourceUrl: z.string().url().optional(),
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
  const oneApiKey = process.env.ONE_API_KEY;
  const oneGithubConnectionKey = process.env.ONE_GITHUB_CONNECTION_KEY;
  const oneGithubActionKey = process.env.ONE_GITHUB_ACTION_KEY || process.env.ONE_GITHUB_CREATE_ISSUE_ACTION_ID;
  const githubOwner = process.env.GITHUB_OWNER;
  const githubRepoName = process.env.GITHUB_REPO_NAME;
  const dryRun = process.env.BOXFIXER_DRY_RUN !== "false";

  if (!boxApiKey) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Missing UPSTASH_BOX_API_KEY env var" }),
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

  if (!oneGithubActionKey) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Missing ONE_GITHUB_ACTION_KEY env var" }),
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
    const issueTitle = `[Site Change] ${data.title}`;
    const issueBody = [
      "A new website change request was submitted.",
      "",
      `Title: ${data.title}`,
      `Description: ${data.description}`,
      data.email ? `Requester email: ${data.email}` : "Requester email: not provided",
      data.sourceUrl ? `Source page: ${data.sourceUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const commandData = {
      title: issueTitle,
      body: issueBody,
      owner: githubOwner,
      repo: githubRepoName,
      repo_owner: githubOwner,
      repo_name: githubRepoName,
      repository: githubRepoName,
    };

    if (dryRun) {
      return {
        statusCode: 202,
        headers: jsonHeaders,
        body: JSON.stringify({
          ok: true,
          dryRun: true,
          message: "Request accepted. Set BOXFIXER_DRY_RUN=false to execute One CLI GitHub issue creation.",
          one: {
            platform: "github",
            actionId: oneGithubActionKey,
            connectionKey: oneGithubConnectionKey,
            data: commandData,
          },
        }),
      };
    }

    const oneOutput = await runOneCli([
      "actions",
      "execute",
      "github",
      oneGithubActionKey,
      oneGithubConnectionKey,
      "-d",
      JSON.stringify(commandData),
    ]);

    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        ok: true,
        dryRun: false,
        oneOutput,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({
        error: "Failed to process change request through One CLI",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
};

async function runOneCli(args) {
  const fullArgs = ["--agent", ...args];

  try {
    const result = await execFileAsync("one", fullArgs, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    return parseCliStdout(result.stdout);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const fallback = await execFileAsync("./node_modules/.bin/one", fullArgs, {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      });
      return parseCliStdout(fallback.stdout);
    }

    throw error;
  }
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
