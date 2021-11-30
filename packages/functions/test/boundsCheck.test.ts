require('source-map-support').install();

import test from 'tape';
import path from 'path';
import { bounds, Document, NodeIO } from '@gltf-transform/core';
import { boundsCheck } from '../';

test.only('@gltf-transform/function::boundsCheck | accessor', (t) => {
	const io = new NodeIO();
	const doc = io.read(path.join(__dirname, 'in/TwoCubes.glb'));
	const root = doc.getRoot();
	const scene = root.getDefaultScene();

	const { min, max } = bounds(scene);
	const expectedWidth = Math.abs(max[0] - min[0]);
	const expectedHeight = Math.abs(max[1] - min[1]);
	const expectedDepth = Math.abs(max[2] - min[2]);

	console.log({ expectedDepth, expectedHeight, expectedWidth });

	const errorModelValue = {};

	t.plan(1);

	doc.transform(
		boundsCheck(
			{
				expectedWidth: expectedWidth * 0.8,
				expectedHeight: expectedHeight * 0.8,
				expectedDepth: expectedDepth * 0.8,
				attemptRescale: false,
				maxDimensionDiff: 0.001,
			},
			errorModelValue
		)
	);

	console.log({ errorModelValue });
	t.ok(Object.keys(errorModelValue).length > 0);
});
