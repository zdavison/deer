import { Text } from "ink";
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useInput } from "ink";
import { applyKittyData } from "../kitty-input";

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

  // Refs kept in sync with state for use in event handlers to avoid stale closures.
  const valueRef = useRef(value);
  const cursorOffsetRef = useRef(cursorOffset);
  valueRef.current = value;
  cursorOffsetRef.current = cursorOffset;

  // Handle Shift+Enter via the Kitty keyboard protocol escape sequence (\x1b[13;2u).
  // Standard terminals send the same \r byte for Enter and Shift+Enter, so Ink's
  // useInput cannot distinguish them. We explicitly request the Kitty keyboard
  // protocol (\x1b[>1u) so terminals that support it (kitty, WezTerm, foot, ghostty,
  // xterm, etc.) send the distinct sequence. On cleanup we pop the mode (\x1b[<u).
  useEffect(() => {
    if (isDisabled) return;
    process.stdout.write("\x1b[>1u");
    const handleData = (data: Buffer) => {
      const result = applyKittyData(data.toString(), valueRef.current, cursorOffsetRef.current);
      if (result) {
        valueRef.current = result.value;
        cursorOffsetRef.current = result.cursor;
        setValue(result.value);
        setCursorOffset(result.cursor);
      }
    };
    process.stdin.on("data", handleData);
    return () => {
      process.stdin.off("data", handleData);
      process.stdout.write("\x1b[<u");
    };
  }, [isDisabled]);

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
          valueRef.current = newValue;
          cursorOffsetRef.current = newCursor;
          setValue(newValue);
          setCursorOffset(newCursor);
        } else {
          // If the character immediately before the cursor is '/', replace it
          // with a newline instead of submitting (like Claude Code's \ continuation).
          const cur = cursorOffsetRef.current;
          const val = valueRef.current;
          if (cur > 0 && val[cur - 1] === "/") {
            const newValue = val.slice(0, cur - 1) + "\n" + val.slice(cur);
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
          const newValue = val.slice(0, cur - 1) + val.slice(cur);
          const newCursor = cur - 1;
          valueRef.current = newValue;
          cursorOffsetRef.current = newCursor;
          setValue(newValue);
          setCursorOffset(newCursor);
        }
      } else if (input) {
        const cur = cursorOffsetRef.current;
        const val = valueRef.current;
        const newValue = val.slice(0, cur) + input + val.slice(cur);
        const newCursor = cur + input.length;
        valueRef.current = newValue;
        cursorOffsetRef.current = newCursor;
        setValue(newValue);
        setCursorOffset(newCursor);
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
    let i = 0;
    for (const char of value) {
      const displayChar = char === "\n" ? "↵" : char;
      if (i === cursorOffset) {
        result.push(<Text key={i} inverse>{displayChar}</Text>);
      } else {
        result.push(displayChar);
      }
      i++;
    }
    if (cursorOffset === value.length) {
      result.push(<Text key="end-cursor" inverse> </Text>);
    }
    return result;
  }, [value, cursorOffset, placeholder, isDisabled]);

  return <Text>{parts}</Text>;
}
