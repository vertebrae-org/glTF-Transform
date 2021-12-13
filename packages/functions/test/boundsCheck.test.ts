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

	const errorModelValue = {};

	const expectedValues = {
		expectedWidth: expectedWidth * 0.8,
		expectedHeight: expectedHeight * 0.8,
		expectedDepth: expectedDepth * 0.8,
		maxDimensionDiff: 0.0001,
	};

	t.plan(4);

	doc.transform(
		boundsCheck(
			{
				...expectedValues,
				attemptRescale: false,
			},
			errorModelValue
		)
	);

	t.ok(Object.keys(errorModelValue).length > 0);

	doc.transform(
		boundsCheck({
			...expectedValues,
			attemptRescale: true,
		})
	);

	const { min: rescaledMin, max: rescaledMax } = bounds(scene);
	const rescaledWidth = Math.abs(rescaledMax[0] - rescaledMin[0]);
	const rescaledHeight = Math.abs(rescaledMax[1] - rescaledMin[1]);
	const rescaledDepth = Math.abs(rescaledMax[2] - rescaledMin[2]);

	t.ok(rescaledWidth < expectedWidth);
	t.ok(rescaledHeight < expectedHeight);
	t.ok(rescaledDepth < expectedDepth);
});
