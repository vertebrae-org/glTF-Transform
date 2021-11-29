require('source-map-support').install();

import test from 'tape';
import path from 'path';
import { Document, NodeIO } from '@gltf-transform/core';

test('@gltf-transform/function::boundsCheck | accessor', (t) => {
	const io = new NodeIO();
	const doc = io.read(path.join(__dirname, 'in/TwoCubes.glb'));
});
