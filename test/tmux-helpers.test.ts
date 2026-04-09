import { test, expect, describe } from "bun:test";
import { stripAnsi } from "../src/dashboard";

describe("stripAnsi", () => {
  test("removes color codes", () => {
    expect(stripAnsi("\x1b[32mgreen text\x1b[0m")).toBe("green text");
  });

  test("removes bold/underline sequences", () => {
    expect(stripAnsi("\x1b[1mbold\x1b[22m \x1b[4munderline\x1b[24m")).toBe("bold underline");
  });

  test("removes cursor movement sequences", () => {
    expect(stripAnsi("\x1b[2J\x1b[H\x1b[3Ahello")).toBe("hello");
  });

  test("strips control characters", () => {
    expect(stripAnsi("hello\x07world\x08!")).toBe("helloworld!");
  });

  test("passes through plain text unchanged", () => {
    expect(stripAnsi("hello world 123")).toBe("hello world 123");
  });

  test("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  test("removes compound SGR sequences", () => {
    expect(stripAnsi("\x1b[38;5;196mred\x1b[0m")).toBe("red");
  });
});
