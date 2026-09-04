const assert = require('assert');

const orchestrator = require('../extension/detection-orchestrator.js');
const { mergeRegions } = orchestrator;

function runCoordinateChecks() {
  const adjacent = mergeRegions([
    { x: 12, y: 80, w: 120, h: 24, type: 'password' },
    { x: 150, y: 80, w: 120, h: 24, type: 'password' },
  ], [], []);

  assert.strictEqual(adjacent.length, 2, 'Adjacent password fields should remain separate regions.');

  const duplicate = mergeRegions([
    { x: 25, y: 120, w: 130, h: 26, type: 'password' },
    { x: 25, y: 120, w: 130, h: 26, type: 'password' },
  ], [], []);

  assert.strictEqual(duplicate.length, 1, 'Duplicate password regions should collapse to a single merged region.');

  console.log('Coordinate mapping checks passed: adjacent fields remain separate and duplicates collapse.');
}

runCoordinateChecks();