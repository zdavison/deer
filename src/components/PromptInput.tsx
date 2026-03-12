import { Text } from "ink";
import React, { useState, useRef, useMemo, useEffect } from "react";
import { useInput } from "ink";

/** Number of newlines required for pasted text to be shown collapsed (fallback without bracketed paste mode). */
const PASTE_LINE_THRESHOLD = 5;

// Bracketed paste markers — with and without the leading ESC byte, since Ink
// may strip \x1b before delivering the raw input string to useInput handlers.
const PASTE_START = "\x1b[200~";
const PASTE_START_ALT = "[200~";
const PASTE_END = "\x1b[201~";
const PASTE_END_ALT = "[201~";

type PasteBlock = { start: number; end: number; id: number };

function shiftBlocks(blocks: PasteBlock[], afterPos: number, delta: number): PasteBlock[] {
  return blocks.map((b) => {
    if (b.start >= afterPos) return { ...b, start: b.start + delta, end: b.end + delta };
    if (b.end > afterPos) return { ...b, end: b.end + delta };
    return b;
  });
}

/** Text input that supports Shift+Enter or /↵ to insert newlines and Enter to submit. */
export function PromptInput({
  defaultValue = "",
  placeholder = "",
  isDisabled = false,
  onSubmit,
}: {
  defaultValue?: string;
  placeholder?: string;
  isDisabled?: boolean;
  onSubmit?: (value: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const [cursorOffset, setCursorOffset] = useState(defaultValue.length);
  const [pasteBlocks, setPasteBlocks] = useState<PasteBlock[]>([]);

  // Refs kept in sync with state for use in event handlers to avoid stale closures.
  const valueRef = useRef(value);
  const cursorOffsetRef = useRef(cursorOffset);
  const pasteBlocksRef = useRef<PasteBlock[]>(pasteBlocks);
  const pasteCountRef = useRef(0);
  valueRef.current = value;
  cursorOffsetRef.current = cursorOffset;
  pasteBlocksRef.current = pasteBlocks;

  // Enable bracketed paste mode so the terminal wraps pasted text in
  // \x1b[200~ ... \x1b[201~ markers, delivering it as a single input event.
  useEffect(() => {
    if (isDisabled) return;
    process.stdout.write("\x1b[?2004h");
    return () => {
      process.stdout.write("\x1b[?2004l");
    };
  }, [isDisabled]);

  // Ink v6 Kitty keyboard protocol is opt-in via render()'s kittyKeyboard
  // option (set in cli.tsx). When active, \x1b[13;2u is parsed into
  // key.return + key.shift, which we handle below.

  useInput(
    (input, key) => {
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && input === "c") ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }

      if (key.return) {
        if (key.shift) {
          const cur = cursorOffsetRef.current;
          const val = valueRef.current;
          const newValue = val.slice(0, cur) + "\n" + val.slice(cur);
          const newCursor = cur + 1;
          const newBlocks = shiftBlocks(pasteBlocksRef.current, cur, 1);
          valueRef.current = newValue;
          cursorOffsetRef.current = newCursor;
          pasteBlocksRef.current = newBlocks;
          setValue(newValue);
          setCursorOffset(newCursor);
          setPasteBlocks(newBlocks);
        } else {
          // If the character immediately before the cursor is '/', replace it
          // with a newline instead of submitting (like Claude Code's \ continuation).
          const cur = cursorOffsetRef.current;
          const val = valueRef.current;
          if (cur > 0 && val[cur - 1] === "/") {
            const newValue = val.slice(0, cur - 1) + "\n" + val.slice(cur);
            // Same length replacement — paste block offsets unchanged.
            valueRef.current = newValue;
            cursorOffsetRef.current = cur;
            setValue(newValue);
            setCursorOffset(cur);
          } else {
            onSubmit?.(valueRef.current);
          }
        }
        return;
      }

      if (key.leftArrow) {
        const newCursor = Math.max(0, cursorOffsetRef.current - 1);
        cursorOffsetRef.current = newCursor;
        setCursorOffset(newCursor);
      } else if (key.rightArrow) {
        const newCursor = Math.min(valueRef.current.length, cursorOffsetRef.current + 1);
        cursorOffsetRef.current = newCursor;
        setCursorOffset(newCursor);
      } else if (key.backspace || key.delete) {
        const cur = cursorOffsetRef.current;
        if (cur > 0) {
          const val = valueRef.current;
          const blocks = pasteBlocksRef.current;
          // If the cursor is inside (or at the end of) a paste block, delete the whole block.
          const blockIdx = blocks.findIndex((b) => b.start < cur && cur <= b.end);
          if (blockIdx >= 0) {
            const block = blocks[blockIdx];
            const blockLen = block.end - block.start;
            const newValue = val.slice(0, block.start) + val.slice(block.end);
            const newCursor = block.start;
            const newBlocks = blocks
              .filter((_, i) => i !== blockIdx)
              .map((b) => (b.start >= block.end ? { ...b, start: b.start - blockLen, end: b.end - blockLen } : b));
            valueRef.current = newValue;
            cursorOffsetRef.current = newCursor;
            pasteBlocksRef.current = newBlocks;
            setValue(newValue);
            setCursorOffset(newCursor);
            setPasteBlocks(newBlocks);
          } else {
            const newValue = val.slice(0, cur - 1) + val.slice(cur);
            const newCursor = cur - 1;
            const newBlocks = shiftBlocks(blocks, cur - 1, -1);
            valueRef.current = newValue;
            cursorOffsetRef.current = newCursor;
            pasteBlocksRef.current = newBlocks;
            setValue(newValue);
            setCursorOffset(newCursor);
            setPasteBlocks(newBlocks);
          }
        }
      } else if (input) {
        // Strip Kitty keyboard protocol responses (e.g. \x1b[?0u) that the
        // terminal sends back when the protocol is enabled. Also detect and
        // strip bracketed paste markers (\x1b[200~ ... \x1b[201~).
        let cleaned = input.replace(/\[\?\d+u/g, "");
        if (!cleaned) return;

        let isBracketedPaste = false;
        let pasteStartIdx = cleaned.indexOf(PASTE_START);
        let pasteStartLen = PASTE_START.length;
        if (pasteStartIdx === -1) {
          pasteStartIdx = cleaned.indexOf(PASTE_START_ALT);
          pasteStartLen = PASTE_START_ALT.length;
        }
        if (pasteStartIdx !== -1) {
          const searchFrom = pasteStartIdx + pasteStartLen;
          let pasteEndIdx = cleaned.indexOf(PASTE_END, searchFrom);
          if (pasteEndIdx === -1) pasteEndIdx = cleaned.indexOf(PASTE_END_ALT, searchFrom);
          if (pasteEndIdx !== -1) {
            cleaned = cleaned.slice(searchFrom, pasteEndIdx);
          } else {
            cleaned = cleaned.slice(searchFrom);
          }
          isBracketedPaste = true;
          if (!cleaned) return;
        } else if (cleaned === PASTE_END || cleaned === PASTE_END_ALT) {
          // Standalone end marker from a split bracketed-paste event — discard.
          return;
        }

        const cur = cursorOffsetRef.current;
        const val = valueRef.current;
        const newValue = val.slice(0, cur) + cleaned + val.slice(cur);
        const newCursor = cur + cleaned.length;

        // Shift existing blocks that start at or after the insertion point.
        const shiftedBlocks = shiftBlocks(pasteBlocksRef.current, cur, cleaned.length);

        const lineCount = (cleaned.match(/\n/g) ?? []).length;
        let newBlocks: PasteBlock[];
        if (isBracketedPaste || lineCount >= PASTE_LINE_THRESHOLD) {
          const pasteId = ++pasteCountRef.current;
          newBlocks = [...shiftedBlocks, { start: cur, end: cur + cleaned.length, id: pasteId }];
        } else {
          newBlocks = shiftedBlocks;
        }

        valueRef.current = newValue;
        cursorOffsetRef.current = newCursor;
        pasteBlocksRef.current = newBlocks;
        setValue(newValue);
        setCursorOffset(newCursor);
        setPasteBlocks(newBlocks);
      }
    },
    { isActive: !isDisabled },
  );

  const parts = useMemo(() => {
    if (isDisabled) {
      return [<Text key="val" dimColor>{placeholder}</Text>];
    }
    if (value.length === 0) {
      if (!placeholder) {
        return [<Text key="cursor" inverse> </Text>];
      }
      return [
        <Text key="cursor" inverse>{placeholder[0]}</Text>,
        <Text key="rest" dimColor>{placeholder.slice(1)}</Text>,
      ];
    }

    const result: React.ReactNode[] = [];
    const sortedBlocks = [...pasteBlocks].sort((a, b) => a.start - b.start);
    let blockIdx = 0;
    let i = 0;

    while (i <= value.length) {
      if (i === value.length) {
        if (cursorOffset === value.length) {
          result.push(<Text key="end-cursor" inverse> </Text>);
        }
        break;
      }

      const currentBlock = sortedBlocks[blockIdx];
      if (currentBlock && i === currentBlock.start) {
        const blockText = value.slice(currentBlock.start, currentBlock.end);
        const lines = blockText.split("\n").length;
        const label = `[Pasted text #${currentBlock.id} +${lines} lines]`;
        const cursorOnBlock = cursorOffset >= currentBlock.start && cursorOffset < currentBlock.end;
        result.push(
          cursorOnBlock
            ? <Text key={`paste-${currentBlock.id}`} inverse>{label}</Text>
            : <Text key={`paste-${currentBlock.id}`}>{label}</Text>,
        );
        i = currentBlock.end;
        blockIdx++;
      } else {
        const char = value[i];
        const displayChar = char === "\n" ? "↵" : char;
        if (i === cursorOffset) {
          result.push(<Text key={i} inverse>{displayChar}</Text>);
        } else {
          result.push(displayChar);
        }
        i++;
      }
    }

    return result;
  }, [value, cursorOffset, pasteBlocks, placeholder, isDisabled]);

  return <Text>{parts}</Text>;
}
