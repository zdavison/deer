let _ghToken: string | null | undefined = undefined;

/** Get the GitHub auth token, cached after first call. */
export async function getGitHubToken(): Promise<string | null> {
  if (_ghToken !== undefined) return _ghToken;
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    _ghToken = code === 0 ? (await new Response(proc.stdout).text()).trim() : null;
  } catch {
    _ghToken = null;
  }
  return _ghToken;
}

/** Parse a GitHub PR URL into owner, repo, and PR number. */
export function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/** Check the current state of a PR via the GitHub REST API. */
export async function checkPrState(prUrl: string): Promise<"open" | "merged" | "closed" | null> {
  try {
    const token = await getGitHubToken();
    const parsed = parsePrUrl(prUrl);
    if (!parsed) return null;
    const { owner, repo, number } = parsed;
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (!res.ok) return null;
    const data = await res.json() as { state: string; merged: boolean };
    if (data.merged) return "merged";
    if (data.state === "closed") return "closed";
    return "open";
  } catch {
    return null;
  }
}
