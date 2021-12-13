import { Transform, Document, bounds, Scene } from '@gltf-transform/core';
import { createTransform } from './utils';

const NAME = 'boundsCheck';

export interface BoundsOptions {
	expectedWidth: number;
	expectedHeight: number;
	expectedDepth: number;
	maxDimensionDiff: number;
	attemptRescale: boolean;
}

export interface ErrorModelValue {
	height?: number;
	width?: number;
	depth?: number;
	expectedHeight?: number;
	expectedWidth?: number;
	expectedDepth?: number;
}

interface Dimensions {
	width: number;
	height: number;
	depth: number;
	[key: string]: number;
}

const rescaleAsset = (scene: Scene, scale: number) => {
	const children = scene.listChildren();
	children.forEach((child) => child.setScale([scale, scale, scale]));
};

const checkWithinMaxDiff = (diff: any, maxDiff: number) => {
	let result = true;
	['width', 'height', 'depth'].forEach((dim2) => {
		if (Math.abs(diff[dim2]) >= maxDiff) {
			result = false;
		}
	});
	return result;
};

const getSumOfDimensions = (dimensions: Dimensions) => {
	return (
		Math.abs(dimensions.width) +
		Math.abs(dimensions.height) +
		Math.abs(dimensions.depth)
	);
};

export const boundsCheck = (
	boundsOptions: BoundsOptions,
	errorModelValue: ErrorModelValue = {}
): Transform => {
	return createTransform(NAME, (doc: Document): void => {
		const root = doc.getRoot();
		const scene = root.listScenes()[0];
		const { min, max } = bounds(scene);

		const {
			expectedWidth,
			expectedHeight,
			expectedDepth,
			maxDimensionDiff,
			attemptRescale,
		} = boundsOptions;

		const actualWidth = Math.abs(max[0] - min[0]);
		const actualHeight = Math.abs(max[1] - min[1]);
		const actualDepth = Math.abs(max[2] - min[2]);

		if (!attemptRescale) {
			if (!expectedWidth) {
				Object.assign(errorModelValue, {
					width: actualWidth,
					expectedWidth: -1,
				});
			}
			if (!expectedHeight) {
				Object.assign(errorModelValue, {
					height: actualHeight,
					expectedHeight: -1,
				});
			}
			if (!expectedDepth) {
				Object.assign(errorModelValue, {
					depth: actualDepth,
					expectedDepth: -1,
				});
			}

			if (Object.keys(errorModelValue).length > 0) return;
		}

		const heightDiff = Math.abs(expectedHeight - actualHeight);

		//Default orientation
		const widthXZDiff = Math.abs(expectedWidth - actualWidth);
		const depthXZDiff = Math.abs(expectedDepth - actualDepth);
		const averageXZDiff = (widthXZDiff + depthXZDiff) / 2;

		const fitsXZWidth = widthXZDiff < maxDimensionDiff;
		const fitsXZDepth = depthXZDiff < maxDimensionDiff;

		const fitsXZDiff = fitsXZWidth && fitsXZDepth;

		//Rotated orientation
		const widthZXDiff = Math.abs(expectedWidth - actualDepth);
		const depthZXDiff = Math.abs(expectedDepth - actualWidth);
		const averageZXDiff = (widthZXDiff + depthZXDiff) / 2;

		const fitsZXWidth = widthZXDiff <= maxDimensionDiff;
		const fitsZXDepth = depthZXDiff <= maxDimensionDiff;

		const fitsZXDiff = fitsZXWidth && fitsZXDepth;

		const isDefaultOrientation = averageXZDiff <= averageZXDiff;

		//Rescale asset
		if (attemptRescale) {
			const expected: Dimensions = {
				width: expectedWidth,
				height: expectedHeight,
				depth: expectedDepth,
			};
			const actual: Dimensions = {
				width: isDefaultOrientation ? actualWidth : actualDepth,
				height: actualHeight,
				depth: isDefaultOrientation ? actualDepth : actualWidth,
			};

			let optimalScale;

			['width', 'height', 'depth'].forEach((dim) => {
				const actualDim = actual[dim];
				const expectedDim = expected[dim];

				let correctionFactor = 1;
				if (actualDim > expectedDim) {
					correctionFactor =
						actualDim / (expectedDim + maxDimensionDiff - 0.0001);
				} else {
					correctionFactor =
						actualDim / (expectedDim - maxDimensionDiff + 0.0001);
				}

				const newAssetDimensions = {
					width: actual.width / correctionFactor,
					height: actual.height / correctionFactor,
					depth: actual.depth / correctionFactor,
				};

				const newDiff = {
					width: newAssetDimensions.width - expected.width,
					height: newAssetDimensions.height - expected.height,
					depth: newAssetDimensions.depth - expected.depth,
				};

				let currentDiff = getSumOfDimensions(newDiff);

				const isWithinMaxDiff = checkWithinMaxDiff(
					newDiff,
					maxDimensionDiff
				);

				if (isWithinMaxDiff) {
					let stepScale = 1 / correctionFactor;

					let currentStepScale = stepScale;
					const step = 0.00001 * (actualDim > expectedDim ? -1 : 1);

					let prevDiff = Infinity;
					const stepDiff = { width: 0, height: 0, depth: 0 };

					while (
						currentDiff < prevDiff &&
						checkWithinMaxDiff(stepDiff, maxDimensionDiff)
					) {
						prevDiff = currentDiff;
						currentStepScale = stepScale;
						stepScale += step;

						const stepAssetDimensions = {
							width: actual.width * stepScale,
							height: actual.height * stepScale,
							depth: actual.depth * stepScale,
						};

						stepDiff.width =
							stepAssetDimensions.width - expected.width;
						stepDiff.height =
							stepAssetDimensions.height - expected.height;
						stepDiff.depth =
							stepAssetDimensions.depth - expected.depth;

						currentDiff = getSumOfDimensions(stepDiff);
					}
					optimalScale = currentStepScale;
					rescaleAsset(scene, optimalScale);
				}
			});
		} else {
			//height check
			if (heightDiff > maxDimensionDiff) {
				errorModelValue.height = actualHeight;
				errorModelValue.expectedHeight = expectedHeight;
			}

			if (!fitsXZDiff && !fitsZXDiff) {
				if (isDefaultOrientation) {
					//Default orientation
					if (!fitsXZWidth) {
						errorModelValue.width = actualWidth;
						errorModelValue.expectedWidth = expectedWidth;
					}
					if (!fitsXZDepth) {
						errorModelValue.depth = actualDepth;
						errorModelValue.expectedDepth = expectedDepth;
					}
				} else {
					//Rotated orientation
					if (!fitsZXWidth) {
						errorModelValue.width = actualDepth;
						errorModelValue.expectedWidth = expectedWidth;
					}
					if (!fitsZXDepth) {
						errorModelValue.depth = actualWidth;
						errorModelValue.expectedDepth = expectedDepth;
					}
				}
			}
		}
	});
};
