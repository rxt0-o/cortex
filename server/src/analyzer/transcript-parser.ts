import fs from 'fs';
import readline from 'readline';

export interface TranscriptMessage {
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  timestamp?: string;
}

export interface ParsedTranscript {
  messages: TranscriptMessage[];
  toolCalls: ToolCall[];
  filesModified: string[];
  errorMessages: string[];
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  output?: string;
}

// Parse Claude Code JSONL transcript file
export async function parseTranscript(transcriptPath: string): Promise<ParsedTranscript> {
  const messages: TranscriptMessage[] = [];
  const toolCalls: ToolCall[] = [];
  const filesModified = new Set<string>();
  const errorMessages: string[] = [];

  if (!fs.existsSync(transcriptPath)) {
    return { messages, toolCalls, filesModified: [], errorMessages };
  }

  const fileStream = fs.createReadStream(transcriptPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);
      processEntry(entry, messages, toolCalls, filesModified, errorMessages);
    } catch {
      // Skip malformed lines
    }
  }

  return {
    messages,
    toolCalls,
    filesModified: [...filesModified],
    errorMessages,
  };
}

function processEntry(
  entry: Record<string, unknown>,
  messages: TranscriptMessage[],
  toolCalls: ToolCall[],
  filesModified: Set<string>,
  errorMessages: string[]
): void {
  const type = entry.type as string;

  if (type === 'user' || type === 'human') {
    const content = extractContent(entry);
    if (content) {
      messages.push({ type: 'user', content });
    }
  } else if (type === 'assistant') {
    const content = extractContent(entry);
    if (content) {
      messages.push({ type: 'assistant', content });
    }

    // Extract tool uses from assistant message
    const contentBlocks = entry.content as unknown[];
    if (Array.isArray(contentBlocks)) {
      for (const block of contentBlocks) {
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_use') {
          const toolName = b.name as string;
          const toolInput = b.input as Record<string, unknown>;
          toolCalls.push({ tool: toolName, input: toolInput });

          // Track file modifications
          if (['Write', 'Edit'].includes(toolName) && toolInput.file_path) {
            filesModified.add(toolInput.file_path as string);
          }
        }
      }
    }
  } else if (type === 'tool_result') {
    const content = extractContent(entry);
    if (content) {
      // Check for error patterns
      if (content.toLowerCase().includes('error') || content.toLowerCase().includes('failed')) {
        errorMessages.push(content.slice(0, 500));
      }

      // Attach to last tool call
      if (toolCalls.length > 0) {
        toolCalls[toolCalls.length - 1].output = content.slice(0, 2000);
      }
    }
  }
}

function extractContent(entry: Record<string, unknown>): string | null {
  const content = entry.content;

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        textParts.push(b.text);
      }
    }
    return textParts.length > 0 ? textParts.join('\n') : null;
  }

  return null;
}

// Extract key decisions from assistant messages
export function extractDecisions(messages: TranscriptMessage[]): string[] {
  const decisionPatterns = [
    /(?:I(?:'ll| will) |let(?:'s| us) |we should |decided to |choosing |went with )(.*?)(?:\.|$)/gi,
    /(?:entschied|entscheidung|beschlossen|gewählt|nutze|verwende)(.*?)(?:\.|$)/gi,
  ];

  const decisions: string[] = [];
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    for (const pattern of decisionPatterns) {
      const matches = msg.content.matchAll(pattern);
      for (const match of matches) {
        const decision = match[0].trim();
        if (decision.length > 20 && decision.length < 500) {
          decisions.push(decision);
        }
      }
    }
  }

  return decisions;
}

// Extract TODO / unfinished items
export function extractUnfinished(messages: TranscriptMessage[]): string[] {
  const todoPatterns = [
    /(?:TODO|FIXME|HACK|XXX|LATER|machen wir später|noch zu tun|als nächstes)[\s:]+(.+?)(?:\n|$)/gi,
    /(?:we(?:'ll| will) (?:do|fix|add|handle) (?:that|this|it) later)(.*?)(?:\.|$)/gi,
  ];

  const items: string[] = [];
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    for (const pattern of todoPatterns) {
      const matches = msg.content.matchAll(pattern);
      for (const match of matches) {
        const item = match[0].trim();
        if (item.length > 10 && item.length < 300) {
          items.push(item);
        }
      }
    }
  }

  return items;
}
