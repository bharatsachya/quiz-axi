import { readFile } from "node:fs/promises";

import { AxiError } from "axi-sdk-js";

import { parseDiffHunks } from "./diff.js";

const QUESTION_TYPES = new Set(["multiple-choice", "free-text"]);

export async function loadQuizSpec(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    throw new AxiError(`Quiz spec not found: ${filePath}`, "NOT_FOUND", [
      "Generate a quiz.json describing questions about the diff, then run `quiz-axi review --quiz <path>`",
    ]);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AxiError(`Quiz spec is not valid JSON: ${filePath}`, "VALIDATION_ERROR", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  return validateQuizSpec(parsed);
}

export function validateQuizSpec(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AxiError("Quiz spec must be a JSON object", "VALIDATION_ERROR");
  }
  const questionsInput = Array.isArray(raw.questions) ? raw.questions : null;
  if (!questionsInput || questionsInput.length === 0) {
    throw new AxiError("Quiz spec must include a non-empty `questions` array", "VALIDATION_ERROR");
  }

  const seenIds = new Set();
  const questions = questionsInput.map((question, index) => normalizeQuestion(question, index, seenIds));

  return {
    version: Number.isInteger(raw.version) ? raw.version : 1,
    diff_summary: typeof raw.diff_summary === "string" ? raw.diff_summary : "",
    questions,
  };
}

function normalizeQuestion(question, index, seenIds) {
  if (!question || typeof question !== "object" || Array.isArray(question)) {
    throw new AxiError(`questions[${index}] must be an object`, "VALIDATION_ERROR");
  }
  const id = typeof question.id === "string" ? question.id.trim() : "";
  if (!id) {
    throw new AxiError(`questions[${index}] is missing a non-empty \`id\``, "VALIDATION_ERROR");
  }
  if (seenIds.has(id)) {
    throw new AxiError(`Duplicate question id "${id}"`, "VALIDATION_ERROR", ["Question ids must be unique"]);
  }
  seenIds.add(id);

  const type = question.type;
  if (!QUESTION_TYPES.has(type)) {
    throw new AxiError(`questions[${index}] ("${id}") has an invalid type: ${JSON.stringify(question.type)}`, "VALIDATION_ERROR", [
      'type must be "multiple-choice" or "free-text"',
    ]);
  }

  const prompt = typeof question.prompt === "string" ? question.prompt.trim() : "";
  if (!prompt) {
    throw new AxiError(`questions[${index}] ("${id}") is missing a non-empty \`prompt\``, "VALIDATION_ERROR");
  }

  let choices;
  if (type === "multiple-choice") {
    const choicesInput = Array.isArray(question.choices) ? question.choices : null;
    if (!choicesInput || choicesInput.length < 2) {
      throw new AxiError(`questions[${index}] ("${id}") needs at least 2 \`choices\``, "VALIDATION_ERROR");
    }
    const seenChoiceIds = new Set();
    choices = choicesInput.map((choice, choiceIndex) => {
      const choiceId = typeof choice?.id === "string" ? choice.id.trim() : "";
      const text = typeof choice?.text === "string" ? choice.text.trim() : "";
      if (!choiceId || !text) {
        throw new AxiError(`questions[${index}].choices[${choiceIndex}] needs a non-empty \`id\` and \`text\``, "VALIDATION_ERROR");
      }
      if (seenChoiceIds.has(choiceId)) {
        throw new AxiError(`questions[${index}] ("${id}") has duplicate choice id "${choiceId}"`, "VALIDATION_ERROR");
      }
      seenChoiceIds.add(choiceId);
      return { id: choiceId, text };
    });
  }

  const hunkAnchor = normalizeHunkAnchor(question.hunk_anchor, index, id);

  return { id, type, prompt, ...(choices ? { choices } : {}), hunk_anchor: hunkAnchor };
}

function normalizeHunkAnchor(anchor, index, id) {
  if (anchor === null || anchor === undefined) return null;
  if (typeof anchor !== "object" || Array.isArray(anchor)) {
    throw new AxiError(`questions[${index}] ("${id}") has an invalid hunk_anchor`, "VALIDATION_ERROR");
  }
  const file = typeof anchor.file === "string" ? anchor.file.trim() : "";
  const startLine = Number(anchor.start_line);
  const endLine = Number(anchor.end_line);
  if (!file || !Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) {
    throw new AxiError(`questions[${index}] ("${id}") has an invalid hunk_anchor`, "VALIDATION_ERROR", [
      "hunk_anchor needs {file, start_line, end_line} with start_line <= end_line",
    ]);
  }
  return { file, start_line: startLine, end_line: endLine };
}

// Matches each question's hunk_anchor against the diff hunks *independently computed
// server-side* (never the agent's own copy), so a card renders next to its real hunk. An
// anchor that doesn't match any real hunk degrades to unanchored rather than erroring.
export function matchHunkAnchors(spec, diffText) {
  const diffFiles = parseDiffHunks(diffText);
  const byFile = new Map(diffFiles.map((entry) => [entry.file, entry.hunks]));
  const questions = spec.questions.map((question) => {
    if (!question.hunk_anchor) return { ...question, anchor_matched: false };
    const hunks = byFile.get(question.hunk_anchor.file) || [];
    const matched = hunks.some(
      (hunk) => question.hunk_anchor.start_line <= hunk.endLine && question.hunk_anchor.end_line >= hunk.startLine,
    );
    return { ...question, anchor_matched: matched };
  });
  return { ...spec, questions };
}
