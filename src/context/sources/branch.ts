import { fuzzyMatch } from "../../fuzzy";
import type { ContextSource, ContextSourceItem, ContextChip } from "../types";

export const branchSource: ContextSource = {
  type: "branch",
  label: "Branch",
  icon: "⎇",

  async search(query: string, repoPath: string): Promise<ContextSourceItem[]> {
    const fmt = "%(refname:short)";
    const result = await Bun.$`git -C ${repoPath} branch --all --format=${fmt}`
      .quiet()
      .nothrow();
    if (result.exitCode !== 0) return [];

    const seen = new Set<string>();
    const branches = result.stdout
      .toString()
      .split("\n")
      .map((b) => b.trim().replace(/^origin\//, ""))
      .filter((b) => {
        if (!b || b.includes("HEAD") || b.includes("->")) return false;
        if (seen.has(b)) return false;
        seen.add(b);
        return true;
      });

    const filtered = query.length > 0
      ? branches.filter((b) => fuzzyMatch(b, query))
      : branches;

    return filtered.map((b) => ({ id: b, label: b }));
  },

  toChip(item: ContextSourceItem): ContextChip {
    return { type: "branch", label: item.label, value: item.id };
  },
};
