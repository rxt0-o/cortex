// Parse unified diff format into structured data

export interface ParsedDiff {
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  hunks: DiffHunk[];
  linesAdded: number;
  linesRemoved: number;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  lineNumber: number;
}

export function parseDiff(diffText: string): ParsedDiff[] {
  const files: ParsedDiff[] = [];
  const fileChunks = diffText.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const parsed = parseFileChunk(chunk);
    if (parsed) files.push(parsed);
  }

  return files;
}

function parseFileChunk(chunk: string): ParsedDiff | null {
  const lines = chunk.split('\n');

  // Extract file path from first line: a/path b/path
  const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
  if (!headerMatch) return null;

  const filePath = headerMatch[2];

  // Determine change type
  let changeType: ParsedDiff['changeType'] = 'modified';
  if (chunk.includes('new file mode')) changeType = 'added';
  else if (chunk.includes('deleted file mode')) changeType = 'deleted';
  else if (chunk.includes('rename from')) changeType = 'renamed';

  // Parse hunks
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let lineNumber = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] ?? '1', 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] ?? '1', 10),
        lines: [],
      };
      lineNumber = parseInt(hunkMatch[3], 10);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentHunk.lines.push({ type: 'add', content: line.slice(1), lineNumber });
      linesAdded++;
      lineNumber++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentHunk.lines.push({ type: 'remove', content: line.slice(1), lineNumber });
      linesRemoved++;
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({ type: 'context', content: line.slice(1), lineNumber });
      lineNumber++;
    }
  }

  if (currentHunk) hunks.push(currentHunk);

  return { filePath, changeType, hunks, linesAdded, linesRemoved };
}

// Get a summary of changes from a diff
export function summarizeDiff(diffs: ParsedDiff[]): string {
  const parts: string[] = [];

  for (const diff of diffs) {
    const action = diff.changeType === 'added' ? 'Added' :
                   diff.changeType === 'deleted' ? 'Deleted' :
                   diff.changeType === 'renamed' ? 'Renamed' : 'Modified';

    parts.push(`${action}: ${diff.filePath} (+${diff.linesAdded}/-${diff.linesRemoved})`);
  }

  return parts.join('\n');
}
