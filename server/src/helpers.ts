import * as decisions from './modules/decisions.js';
import * as learnings from './modules/learnings.js';
import * as errors from './modules/errors.js';

export function runAllPruning(): { decisions_archived: number; learnings_archived: number; errors_archived: number } {
  const d = decisions.runDecisionsPruning();
  const l = learnings.runLearningsPruning();
  const e = errors.runErrorsPruning();
  return {
    decisions_archived: d.decisions_archived,
    learnings_archived: l.learnings_archived,
    errors_archived: e.errors_archived,
  };
}
