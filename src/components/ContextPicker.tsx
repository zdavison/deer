import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { CONTEXT_SOURCES } from "../context/sources/index";
import type { ContextChip, ContextSourceItem, ContextSource } from "../context/types";

interface PickerItem extends ContextSourceItem {
  sourceType: string;
  icon: string;
  source: ContextSource;
}

/** Maximum number of result rows shown at once. */
const MAX_ITEMS = 5;

/**
 * Unified fuzzy picker for all context sources.
 *
 * Renders a search bar followed by merged results from every registered
 * ContextSource. The user types to filter, navigates with arrow keys,
 * and confirms with Enter. Escape or Backspace on an empty query cancels.
 */
export function ContextPicker({
  repoPath,
  onSelect,
  onCancel,
}: {
  repoPath: string;
  onSelect: (chip: ContextChip) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PickerItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    let cancelled = false;

    Promise.all(
      CONTEXT_SOURCES.map((source) =>
        source
          .search(query, repoPath)
          .then((results): PickerItem[] =>
            results.map((item) => ({ ...item, sourceType: source.type, icon: source.icon, source }))
          )
          .catch((): PickerItem[] => [])
      )
    ).then((groups) => {
      if (cancelled) return;
      setItems(groups.flat());
      setSelectedIdx(0);
      setScrollOffset(0);
    });

    return () => { cancelled = true; };
  }, [query, repoPath]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
      return;
    }

    if (key.return) {
      const item = items[selectedIdx];
      if (item) onSelect(item.source.toChip(item));
      return;
    }

    if (key.upArrow) {
      setSelectedIdx((prev) => {
        const next = Math.max(prev - 1, 0);
        setScrollOffset((off) => Math.min(off, next));
        return next;
      });
      return;
    }

    if (key.downArrow) {
      setSelectedIdx((prev) => {
        const next = Math.min(prev + 1, Math.max(items.length - 1, 0));
        setScrollOffset((off) => Math.max(off, next - MAX_ITEMS + 1));
        return next;
      });
      return;
    }

    if (key.backspace || key.delete) {
      if (query.length === 0) {
        onCancel();
      } else {
        setQuery((prev) => prev.slice(0, -1));
      }
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setQuery((prev) => prev + input);
    }
  });

  const visibleItems = items.slice(scrollOffset, scrollOffset + MAX_ITEMS);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Search bar */}
      <Box gap={1}>
        <Text color="cyan">@</Text>
        <Text>
          {query}
          <Text inverse> </Text>
        </Text>
      </Box>

      {/* Results */}
      {visibleItems.length === 0 && query.length > 0 ? (
        <Box paddingLeft={2}>
          <Text dimColor>no matches</Text>
        </Box>
      ) : (
        visibleItems.map((item, i) => (
          <Box key={`${item.sourceType}-${item.id}`} paddingLeft={2} gap={1}>
            <Text
              color={i + scrollOffset === selectedIdx ? "cyan" : undefined}
              inverse={i + scrollOffset === selectedIdx}
            >
              {item.icon}  {item.label}
            </Text>
            {item.sublabel && <Text dimColor>{item.sublabel}</Text>}
          </Box>
        ))
      )}
    </Box>
  );
}
