export interface ActivatedNode {
    type: string;
    id: number;
    activation: number;
}
/**
 * Spreading Activation algorithm (BFS with visited-set).
 *
 * 1. Seed nodes activated at 1.0
 * 2. BFS over memory_associations
 * 3. For each edge where target NOT in visited:
 *    target.activation += source.activation * edge.strength * decay_factor
 * 4. decay_factor = 0.5 per hop
 * 5. Max 3 hops, threshold >= 0.1
 * 6. Result: all activated nodes sorted by activation
 *
 * visited-set is mandatory to prevent circular activation (A->B->A cycles).
 */
export declare function spreadingActivation(seeds: Array<{
    type: string;
    id: number;
}>): ActivatedNode[];
/**
 * Get activated nodes for a set of files (via file-related entities).
 */
export declare function activateForFiles(files: string[]): ActivatedNode[];
//# sourceMappingURL=activation.d.ts.map