import { readFile } from "node:fs/promises";

import { AxiError } from "axi-sdk-js";

import { parseDiffHunks } from "./diff.js";

const QUESTION_TYPES = new Set(["multiple-choice", "free-text"]);
const SIGNIFICANCE_LEVELS = new Set(["trivial", "small", "normal", "high"]);
const DECISION_WHO = new Set(["agent", "human"]);
const KNOWN_TOP_LEVEL_FIELDS = new Set(["version", "diff_summary", "explainer", "decisions", "significance", "questions"]);
const KNOWN_EXPLAINER_FIELDS = new Set(["eli5", "summary", "background", "walkthrough"]);
const KNOWN_WALKTHROUGH_STEP_FIELDS = new Set(["text", "hunk_anchor"]);
const KNOWN_DECISION_FIELDS = new Set(["id", "who", "decision", "why", "alternatives", "hunk_anchor"]);

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

// Accepts quiz.json versions 1 (questions only), 2, and 3 (add explainer/decisions/
// significance) with a single permissive schema - fields introduced in later versions are
// simply optional, so there is no version-specific branching. Unknown top-level or nested
// fields, an unrecognized `version` number, and out-of-enum values (bad `significance`, bad
// decision `who`) are collected into `warnings` and degrade to their default rather than
// rejecting the whole spec - forward compat for a document agents keep evolving.
export function validateQuizSpec(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AxiError("Quiz spec must be a JSON object", "VALIDATION_ERROR");
  }
  const warnings = [];
  warnUnknownFields(raw, KNOWN_TOP_LEVEL_FIELDS, "quiz.json", warnings);

  const version = Number.isInteger(raw.version) ? raw.version : 1;
  if (![1, 2, 3].includes(version)) {
    warnings.push(`Unknown quiz.json version ${version}, parsing fields as version 3`);
  }

  const significance = normalizeSignificance(raw.significance, warnings);
  const explainer = normalizeExplainer(raw.explainer, warnings);
  const decisions = normalizeDecisions(raw.decisions, warnings);

  const questionsInput = Array.isArray(raw.questions) ? raw.questions : null;
  if (!questionsInput) {
    throw new AxiError("Quiz spec must include a `questions` array", "VALIDATION_ERROR");
  }
  if (questionsInput.length === 0 && significance !== "trivial") {
    throw new AxiError('Quiz spec `questions` array cannot be empty unless significance is "trivial"', "VALIDATION_ERROR", [
      'Add at least one question, or set "significance": "trivial" for a review with none.',
    ]);
  }

  const seenIds = new Set();
  const questions = questionsInput.map((question, index) => normalizeQuestion(question, index, seenIds));

  return {
    version,
    diff_summary: typeof raw.diff_summary === "string" ? raw.diff_summary : "",
    ...(significance ? { significance } : {}),
    ...(explainer ? { explainer } : {}),
    ...(decisions.length ? { decisions } : {}),
    questions,
    warnings,
  };
}

function warnUnknownFields(obj, known, label, warnings) {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) warnings.push(`Unknown ${label} field "${key}" ignored`);
  }
}

function normalizeSignificance(raw, warnings) {
  if (raw === undefined || raw === null) return undefined;
  if (SIGNIFICANCE_LEVELS.has(raw)) return raw;
  warnings.push(`Unknown significance "${raw}" ignored`);
  return undefined;
}

function normalizeExplainer(raw, warnings) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AxiError("`explainer` must be an object", "VALIDATION_ERROR");
  }
  warnUnknownFields(raw, KNOWN_EXPLAINER_FIELDS, "explainer", warnings);
  const eli5 = typeof raw.eli5 === "string" && raw.eli5.trim() ? raw.eli5.trim() : undefined;
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  const background = typeof raw.background === "string" && raw.background.trim() ? raw.background.trim() : undefined;
  const walkthroughInput = Array.isArray(raw.walkthrough) ? raw.walkthrough : [];
  const walkthrough = walkthroughInput.map((step, index) => normalizeWalkthroughStep(step, index, warnings));
  return {
    ...(eli5 ? { eli5 } : {}),
    summary,
    ...(background ? { background } : {}),
    walkthrough,
  };
}

function normalizeWalkthroughStep(step, index, warnings) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new AxiError(`explainer.walkthrough[${index}] must be an object`, "VALIDATION_ERROR");
  }
  warnUnknownFields(step, KNOWN_WALKTHROUGH_STEP_FIELDS, `explainer.walkthrough[${index}]`, warnings);
  const text = typeof step.text === "string" ? step.text.trim() : "";
  if (!text) {
    throw new AxiError(`explainer.walkthrough[${index}] is missing a non-empty \`text\``, "VALIDATION_ERROR");
  }
  const hunkAnchor = normalizeHunkAnchor(step.hunk_anchor, `explainer.walkthrough[${index}]`);
  return { text, hunk_anchor: hunkAnchor };
}

function normalizeDecisions(raw, warnings) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AxiError("`decisions` must be an array", "VALIDATION_ERROR");
  }
  const seenIds = new Set();
  return raw.map((decision, index) => normalizeDecision(decision, index, seenIds, warnings));
}

function normalizeDecision(decision, index, seenIds, warnings) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new AxiError(`decisions[${index}] must be an object`, "VALIDATION_ERROR");
  }
  warnUnknownFields(decision, KNOWN_DECISION_FIELDS, `decisions[${index}]`, warnings);
  const id = typeof decision.id === "string" ? decision.id.trim() : "";
  if (!id) {
    throw new AxiError(`decisions[${index}] is missing a non-empty \`id\``, "VALIDATION_ERROR");
  }
  if (seenIds.has(id)) {
    throw new AxiError(`Duplicate decision id "${id}"`, "VALIDATION_ERROR", ["Decision ids must be unique"]);
  }
  seenIds.add(id);
  let who = "agent";
  if (decision.who !== undefined) {
    if (DECISION_WHO.has(decision.who)) {
      who = decision.who;
    } else {
      warnings.push(`decisions[${index}] ("${id}") has unknown \`who\` "${decision.who}", defaulting to "agent"`);
    }
  }
  const decisionText = typeof decision.decision === "string" ? decision.decision.trim() : "";
  if (!decisionText) {
    throw new AxiError(`decisions[${index}] ("${id}") is missing a non-empty \`decision\``, "VALIDATION_ERROR");
  }
  const why = typeof decision.why === "string" ? decision.why.trim() : "";
  const alternatives = Array.isArray(decision.alternatives)
    ? decision.alternatives.filter((alt) => typeof alt === "string" && alt.trim()).map((alt) => alt.trim())
    : [];
  const hunkAnchor = normalizeHunkAnchor(decision.hunk_anchor, `decisions[${index}] ("${id}")`);
  return {
    id,
    who,
    decision: decisionText,
    why,
    ...(alternatives.length ? { alternatives } : {}),
    hunk_anchor: hunkAnchor,
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

  const hunkAnchor = normalizeHunkAnchor(question.hunk_anchor, `questions[${index}] ("${id}")`);

  return { id, type, prompt, ...(choices ? { choices } : {}), hunk_anchor: hunkAnchor };
}

function normalizeHunkAnchor(anchor, label) {
  if (anchor === null || anchor === undefined) return null;
  if (typeof anchor !== "object" || Array.isArray(anchor)) {
    throw new AxiError(`${label} has an invalid hunk_anchor`, "VALIDATION_ERROR");
  }
  const file = typeof anchor.file === "string" ? anchor.file.trim() : "";
  const startLine = Number(anchor.start_line);
  const endLine = Number(anchor.end_line);
  if (!file || !Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) {
    throw new AxiError(`${label} has an invalid hunk_anchor`, "VALIDATION_ERROR", [
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
