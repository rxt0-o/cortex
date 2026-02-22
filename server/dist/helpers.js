import * as decisions from './modules/decisions.js';
import * as learnings from './modules/learnings.js';
import * as errors from './modules/errors.js';
export function runAllPruning() {
    const d = decisions.runDecisionsPruning();
    const l = learnings.runLearningsPruning();
    const e = errors.runErrorsPruning();
    return {
        decisions_archived: d.decisions_archived,
        learnings_archived: l.learnings_archived,
        errors_archived: e.errors_archived,
    };
}
//# sourceMappingURL=helpers.js.map