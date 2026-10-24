import type { AiEditIntent, AiTargetScope } from "./inline";
import type { ChatMessage } from "./chat/types";

type InlineAiSuggestionContext = {
  original: string;
  replacement: string;
};

type BuildInlineAiMessagesInput = {
  documentContent: string;
  intent?: AiEditIntent;
  prompt: string;
  readOnlyContext?: string;
  suggestionContext?: InlineAiSuggestionContext;
  targetContext?: string | null;
  targetScope?: AiTargetScope;
  targetText: string;
  targetType?: "insert" | "replace";
  translationTargetLanguage?: string;
};

type NormalizeInlineAiReplacementOptions = {
  preserveLeadingWhitespace?: boolean;
};

const translateIntentInstruction = [
  "Automatically detect the target text's current language before translating it.",
  "If the target text is mostly English, translate it into Simplified Chinese.",
  "If the target text is mostly Chinese, translate it into English.",
  "For other languages, translate it into English unless the user instruction names another target language.",
  "If the user instruction explicitly names a different target language, use that explicit language instead.",
  "Preserve Markdown formatting."
].join(" ");

const intentInstruction: Record<AiEditIntent, string> = {
  custom: "Follow the user instruction exactly while keeping the edit scoped to the target.",
  polish: "Polish the target text for clarity, flow, grammar, and word choice without adding new facts.",
  rewrite: "Rewrite the target text according to the user instruction while preserving the intended meaning unless asked otherwise.",
  continue: "Continue after the target text. Return only the new Markdown to insert after it. Do not repeat the target text.",
  summarize: "Summarize the target text concisely while preserving the important facts and Markdown readability.",
  translate: translateIntentInstruction
};

const targetScopeLabel: Record<AiTargetScope, string> = {
  block: "Current Markdown block",
  selection: "Selected text",
  suggestion: "Current AI suggestion"
};

export function buildInlineAiMessages({
  documentContent,
  intent = "custom",
  prompt,
  readOnlyContext,
  suggestionContext,
  targetContext = null,
  targetScope = "selection",
  targetText,
  targetType = "replace",
  translationTargetLanguage = "English"
}: BuildInlineAiMessagesInput): ChatMessage[] {
  const trimmedDocumentContext = documentContent.trim();
  const currentSuggestion = suggestionContext
    ? [
        "Current AI suggestion awaiting confirmation:",
        `Original text:\n${suggestionContext.original}`,
        `Suggested replacement:\n${suggestionContext.replacement}`
      ].join("\n\n")
    : null;

  return [
    {
      content: [
        "You are marktion's inline Markdown assistant.",
        "If the user asks a question, answer it directly using the target text and provided context.",
        "If the answer is not present in the provided context, say that briefly.",
        "For editing requests: Return only the Markdown fragment that should be inserted or used as the replacement.",
        "Do not return JSON, metadata, explanations, or alternatives.",
        "Do not wrap the answer in code fences.",
        "Preserve the target's language, tone, and Markdown structure unless the user explicitly asks to change them.",
        "Do not edit unrelated document content."
      ].join(" "),
      role: "system"
    },
    {
      content: [
        `Task:\n${instructionForIntent(intent, translationTargetLanguage)}`,
        `Target scope:\n${targetScopeLabel[targetScope]}`,
        `Edit mode:\n${targetType === "insert" ? "Insert after the target" : "Replace the target"}`,
        `Target text:\n${targetText}`,
        targetContext?.trim() ? `Nearby target context:\n${targetContext.trim()}` : null,
        currentSuggestion,
        trimmedDocumentContext ? `Current document context (read-only):\n${trimmedDocumentContext}` : null,
        readOnlyContext?.trim() ? readOnlyContext : null,
        "Use the target text and nearby target context before any broader document context.",
        `User instruction:\n${prompt.trim()}`,
        "Do not edit unrelated document content."
      ]
        .filter(Boolean)
        .join("\n\n"),
      role: "user"
    }
  ];
}

export function buildInlineAiIntentInstruction(intent: AiEditIntent, translationTargetLanguage = "English") {
  if (intent === "translate") {
    const preferredTargetLanguage = translationTargetLanguage || "English";
    const fallbackTargetLanguage = preferredTargetLanguage === "English" ? "Simplified Chinese" : "English";

    return [
      "Automatically detect the target text's current language before translating it.",
      `Use ${preferredTargetLanguage} as the preferred target language when the target text is not already in ${preferredTargetLanguage}.`,
      `If the target text is already in ${preferredTargetLanguage}, translate it into ${fallbackTargetLanguage} unless the user instruction names another target language.`,
      "If the user instruction explicitly names a different target language, use that explicit language instead.",
      "Preserve Markdown formatting."
    ].join(" ");
  }

  return intentInstruction[intent];
}

function instructionForIntent(intent: AiEditIntent, translationTargetLanguage: string) {
  return buildInlineAiIntentInstruction(intent, translationTargetLanguage);
}

export function normalizeInlineAiReplacement(
  value: string,
  { preserveLeadingWhitespace = false }: NormalizeInlineAiReplacementOptions = {}
) {
  const withoutFence = stripSingleMarkdownFence(value);

  return preserveLeadingWhitespace ? withoutFence.replace(/\s+$/u, "") : withoutFence.trim();
}

function stripSingleMarkdownFence(value: string) {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/iu);

  return fenceMatch?.[1] ?? value;
}
