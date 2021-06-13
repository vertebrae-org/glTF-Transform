import { add } from 'gl-matrix/mat4';
import { cross, dist, dot, multiply, squaredLength, subtract } from 'gl-matrix/vec3';
import { dot as dotVec4, transformMat4 } from 'gl-matrix/vec4';
import Heap from 'heap'; // TODO(bug): Don't use 'heap' — it's unlicensed. Maybe https://github.com/ignlg/heap-js.
import ndarray from 'ndarray';
import { Document, Logger, Primitive, Transform, mat4, vec3, vec4 } from '@gltf-transform/core';
import { weld } from './weld';

const NAME = 'simplify';

const ZERO_MAT4: mat4 = [
	0, 0, 0, 0,
	0, 0, 0, 0,
	0, 0, 0, 0,
	0, 0, 0, 0,
];

export interface SimplifyOptions {
	/** Factor (0–1) by which to simplify the mesh. */
	target: number,

	/**
	 * Threshold for collapsing disjoint vertices. When set to 0, only existing mesh edges are
	 * collapsed, preserving mesh topology. When ≥0, vertices within `threshold` distance of one
	 * another may be collapsed with or without an existing edge connecting them. For large
	 * threshold values, the algorithm must consider n² edges and performance will decline.
	*/
	distanceThreshold?: number;

	/**
	 * Penalty for collapsing seams (edges used by a single face). Note that an unwelded primitive
	 * consists _entirely_ of seams, so use {@link weld} first if necessary.
	 *
	 * TODO(bug): What happens for a mesh with hard normals, exactly?
	 */
	// seamPenalty?: number;

	/**
	 * Penalty for collapsing an edge that would cause a neighboring face to be inverted. When set
	 * to 0, such edges are never collapsed. When ≥0, such edges may be collapsed but are penalized
	 * with the given multiplier.
	 */
	// inversionPenalty?: number;

	/**
	 * Multiplier for errors in a particular vertex attribute. May be used to discourage edge
	 * collapses that would change a particular attribute, or to exclude an attribute from
	 * consideration in edge selection.
	 */
	// attributeWeights?: {[key: string]: number};
}

export const SIMPLIFY_DEFAULTS: SimplifyOptions = {
	target: 0.10,
	distanceThreshold: 0,
	// seamPenalty: 0,
	// inversionPenalty: Infinity,
	// attributeWeights: {}
};

// References:
// - http://www.cs.cmu.edu/~./garland/Papers/quadrics.pdf
// - https://github.com/ataber/mesh-simplify
// - https://github.com/naver/mesh-simplifier
// - https://github.com/BabylonJS/Babylon.js/blob/master/src/Meshes/meshSimplification.ts
// - https://doc.babylonjs.com/divingDeeper/mesh/simplifyingMeshes
// - https://github.com/sp4cerat/Fast-Quadric-Mesh-Simplification
//

/**
 * Mesh simplification with Quadric Error Metrics.
 * @returns
 */
export function simplify(_options: SimplifyOptions = SIMPLIFY_DEFAULTS): Transform {
	const options = {...SIMPLIFY_DEFAULTS, ..._options} as Required<SimplifyOptions>;
	return async (document: Document): Promise<void> => {
		const logger = document.getLogger();

		// Algorithm requires indices.
		await document.transform(weld({tolerance: 0}));

		for (const mesh of document.getRoot().listMeshes()) {
			for (const prim of mesh.listPrimitives()) {
				simplifyPrimitive(prim, logger, options);
			}
		}
	};
}

interface Vertex {
	index: number,
	pairs: number[],
	error: mat4,
	attributes: {
		POSITION: vec3,
		[key: string]: number[],
	}
}

interface Pair {
	vertices: [number, number],
	result: Vertex,
	cost: number;
	isSeam: boolean;
}

function simplifyPrimitive(
	prim: Primitive,
	logger: Logger,
	options: Required<SimplifyOptions>): void {

	/***************************************************************************
	 * Pre-processing and filtering.
	 */

	// Morph target simplification not yet implemented.
	if (prim.listTargets().length > 0) {
		logger.warn(`${NAME}: Skipping primitive; simplifying morph targets not supported.`);
		return;
	}

	// TRIANGLES draw mode supported; other modes not yet implemented.
	if (prim.getMode() !== Primitive.Mode.TRIANGLES) {
		logger.warn(`${NAME}: Skipping primitive; non-TRIANGLES modes not supported.`);
		return;
	}

	// Tangents should not be interpolated during simplification. If necessary, they should be
	// regenerated with the MikkTSpace algorithm implemented by `tangents()`.
	const tangent = prim.getAttribute('TANGENT');
	if (tangent) {
		logger.warn(`${NAME}: Removing tangents. Regenerate with 'tangents' if necessary.`);
		tangent.dispose();
	}

	// TODO(feat): Remove degenerate triangles.


	/***************************************************************************
	 * 1. Compute Q matrices for initial vertices.
	 */

	const vertices = listVertices(prim);
	const indices = prim.getIndices()!.getArray()!; // Welded above.

	for (let i = 0; i < indices.length; i += 3) {
		const a = vertices[indices[i]];
		const b = vertices[indices[i + 1]];
		const c = vertices[indices[i + 2]];
		const normal = getFaceNormal(a, b, c);
		const plane = [normal[0], normal[1], normal[2], dot(a.attributes.POSITION, normal)];

		for (const v of [a, b, c]) {
			const error = ndarray(new Array(4 * 4).fill(0), [4, 4]);
			for (let i = 0; i < 4; i++) {
				for (let j = i; j >= 0; j--) {
					error.set(i, j, plane[i] * plane[j]);
					if (i === j) continue;
					error.set(j, i, plane[i] * plane[j]);
				}
			}

			const prevError = v.error;
			add(prevError, prevError, error.data as mat4);
		}
	}


	/***************************************************************************
	 * 2. Select all valid pairs.
	 */

	for (let i = 0; i < indices.length; i += 3) {
		const a = indices[i];
		const b = indices[i + 1];
		const c = indices[i + 2];

		// TODO(cleanup): Implementation by ataber does a partial iteration, typo?
		const edges = [[a, b], [b, c], [c, a]];
		for (const [indexA, indexB] of edges) {
			// Consistent ordering to prevent double entries.
			if (indexA < indexB) {
				vertices[indexA].pairs.push(indexB);
			} else {
				vertices[indexB].pairs.push(indexA);
			}
		}
	}

	if (options.distanceThreshold > 0) {
		for (let i = 0, il = vertices.length; i < il; i++) {
			// TODO(cleanup): Implementation by ataber used 'cells' here, typo?
			const v1 = vertices[i];
			for (let j = i - 1; j >= 0; j--) {
				const v2 = vertices[j];
				if (dist(v1.attributes.POSITION, v2.attributes.POSITION)
						< options.distanceThreshold) {
					// Consistent ordering to prevent double entries.
					if (i < j) {
						v1.pairs.push(j);
					} else {
						v2.pairs.push(i);
					}
				}
			}
		}
	}


	/***************************************************************************
	 * 3. Place all the pairs in a heap, by ascending cost.
	 */

	const pairs = new Heap<Pair>((a: Pair, b: Pair) => a.cost - b.cost);
	const edges = [] as Pair[];

	for (let i = 0; i < vertices.length; i++) {
		for (const j of vertices[i].pairs) {
			const {result, cost} = merge(vertices[i], vertices[j]);
			const pair = {vertices: [i, j], result, cost} as Pair;
			pairs.push(pair);
			edges.push(pair); // for iteration
		}
	}


	/***************************************************************************
	 * 4. Iteratively remove the pair (v1, v2) of least cost from the heap,
	 * contract this pair, and update the costs of all pairs involving v1.
	 */

	const n = vertices.length;
	const targetCount = Math.round(n * options.target);
	let deletedCount = 0;

	const deletedFaces = new Array<boolean>(indices.length / 3).fill(false);

	while (n - deletedCount > targetCount) {
		const leastCost = pairs.pop();
		const [a, b] = leastCost.vertices;

		if (a === b) continue; // Edge has already been collapsed.

		Object.assign(vertices[a].attributes, leastCost.result.attributes);
		updateVertex(prim, a, vertices[a]);

		// TODO(perf): Optimize?
		for (let i = 0; i < indices.length; i += 3) {
			const cells = [indices[i], indices[i + 1], indices[i + 2]];
			const indexA = cells.indexOf(a);
			const indexB = cells.indexOf(b);

			if (indexB >= 0) {
				if (indexA >= 0) {
					// Delete cells with zero area, as A == B now.
					deletedFaces[i / 3] = true;
				}

				if (indices[i] === b) indices[i] = a;
				if (indices[i + 1] === b) indices[i + 1] = a;
				if (indices[i + 2] === b) indices[i + 2] = a;
			}
		}

		// TODO(perf): Optimize?
		for (const edge of edges) {
			const edgeIndexA = edge.vertices.indexOf(a);
			const edgeIndexB = edge.vertices.indexOf(b);

			if (edgeIndexA >= 0 && edgeIndexB >= 0) {
				edge.vertices[edgeIndexB] = a; // Mark merged.
			} else if (edgeIndexA >= 0) {
				const otherVertex = vertices[edge.vertices[(edgeIndexA + 1) % 2]];
				const {result, cost} = merge(vertices[a], otherVertex);
				edge.result = result;
				edge.cost = cost;
			} else if (edgeIndexB >= 0) {
				const otherVertex = vertices[edge.vertices[(edgeIndexB + 1) % 2]];
				const {result, cost} = merge(vertices[a], otherVertex); // A is replacing B.
				edge.result = result;
				edge.cost = cost;
			}
		}

		// TODO(perf): Optimize?
		pairs.heapify();
		deletedCount++;

		if (!(deletedCount % 100)) {
			logger.debug(`Deleted: ${deletedCount} of ${n - targetCount} vertices.`);
		}
	}

	/***************************************************************************
	 * 5. Update primitive.
	 */

	const numFacesDeleted = deletedFaces.filter((v) => v).length;

	logger.debug(
		`${NAME}: Removed ${numFacesDeleted} of ${indices.length / 3} faces, `
		+ `${deletedCount} of ${vertices.length} vertices.`
	);

	const numIndices = indices.length - numFacesDeleted * 3;
	const indicesArray = indices.slice(0, numIndices);
	let next = 0;
	for (let i = 0; i < indices.length; i += 3) {
		if (deletedFaces[i / 3]) continue;
		indicesArray[next++] = indices[i];
		indicesArray[next++] = indices[i + 1];
		indicesArray[next++] = indices[i + 2];
	}

	console.log(indicesArray);
	prim.getIndices()!.setArray(indicesArray);

	// TODO(bug): Remove orphaned vertices.
}

/***************************************************************************
 * Utilities.
 */

function getFaceNormal(a: Vertex, b: Vertex, c: Vertex): vec3 {
	const v1 = subtract([0, 0, 0], c.attributes.POSITION, b.attributes.POSITION);
	const v2 = subtract([0, 0, 0], a.attributes.POSITION, b.attributes.POSITION);
	const normal = cross([0, 0, 0], v1, v2);
	const lengthSq = squaredLength(normal);
	if (lengthSq > 1) {
		const scalar = 1 / Math.sqrt(lengthSq);
		multiply(normal, normal, [scalar, scalar, scalar]);
	}
	return normal as vec3;
}

function listVertices(prim: Primitive): Vertex[] {
	const vertices = [] as Vertex[];
	const position = prim.getAttribute('POSITION')!;
	for (let i = 0, il = position.getCount(); i < il; i++) {
		const vertex = {
			index: i,
			error: ZERO_MAT4.slice() as mat4,
			pairs: [],
			attributes: {POSITION: [0, 0, 0]},
		} as Vertex;
		for (const semantic of prim.listSemantics()) {
			const attribute = prim.getAttribute(semantic)!;
			vertex.attributes[semantic] = attribute.getElement(i, []);
		}
		vertices.push(vertex);
	}
	return vertices;
}

function merge(a: Vertex, b: Vertex): {result: Vertex, cost: number} {
	// TODO(feat): Linear solve for optimal position.
	const quadratic = add(ZERO_MAT4.slice() as mat4, a.error, b.error) as mat4;

	// TODO(feat): Midpoint collapse logic.
	const aCost = vertexError(a, quadratic);
	const bCost = vertexError(b, quadratic);

	// TODO(feat): Penalize inversions.
	// TODO(feat): Penalize seams.

	return aCost <= bCost
		? {result: a, cost: aCost}
		: {result: b, cost: bCost};
}

function vertexError(vertex: Vertex, quadratic: mat4): number {
	// TODO(feat): Consider other vertex attributes.
	const pos = [
		vertex.attributes.POSITION[0],
		vertex.attributes.POSITION[1],
		vertex.attributes.POSITION[2],
		1
	] as vec4;
	return dotVec4(transformMat4([0, 0, 0, 0], pos, quadratic), pos);
}

function updateVertex(prim: Primitive, index: number, vertex: Vertex): void {
	for (const semantic of prim.listSemantics()) {
		const attribute = prim.getAttribute(semantic)!;
		attribute.setElement(index, vertex.attributes[semantic]);
	}
}
