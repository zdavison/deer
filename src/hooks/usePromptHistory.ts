import { useState, useEffect, useCallback } from "react";
import { loadPromptHistory, savePromptHistory } from "../task";

export function usePromptHistory() {
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [inputDefault, setInputDefault] = useState("");
  const [inputKey, setInputKey] = useState(0);

  useEffect(() => {
    loadPromptHistory().then(setPromptHistory);
  }, []);

  const addToHistory = useCallback((value: string) => {
    setPromptHistory((prev) => {
      const next = [...prev, value.trim()];
      savePromptHistory(next).catch(() => {});
      return next;
    });
    setHistoryIdx(-1);
    setInputDefault("");
    setInputKey((k) => k + 1);
  }, []);

  return {
    promptHistory,
    historyIdx,
    setHistoryIdx,
    inputDefault,
    setInputDefault,
    inputKey,
    setInputKey,
    addToHistory,
  };
}
