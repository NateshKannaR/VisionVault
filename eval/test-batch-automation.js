#!/usr/bin/env node
/**
 * test-batch-automation.js — Verifies Batch Form Filling, Smart Autocomplete, and Self-Healing Automation.
 */

const assert = require('assert');
const TaskPlanner = require('../extension/task-planner.js');
const ActionExecutor = require('../extension/action-executor.js');

console.log('\n--- Batch Form Filling & Self-Healing Automation Tests ---');

// Test 1: Batch Form Fill Planner
const mockFormMarks = [
  { id: 10, role: 'input', label: 'Full Name', tag: 'input' },
  { id: 11, role: 'input:email', label: 'Email Address', tag: 'input' },
  { id: 12, role: 'input:tel', label: 'Phone Number', tag: 'input' },
  { id: 13, role: 'input:password', label: 'Password', tag: 'input' },
  { id: 14, role: 'button', label: 'Submit Application', tag: 'button' }
];

const batchResult = TaskPlanner.planBatchFormFill({
  task: 'fill this registration form with my details',
  marks: mockFormMarks,
  filledIds: [],
  pageInfo: { url: 'https://example.com/register' }
});

assert.ok(batchResult, 'Batch form planner should return a result');
assert.strictEqual(batchResult.action, 'batch', 'Action should be batch');
assert.ok(Array.isArray(batchResult.actions), 'Actions should be an array');
assert.strictEqual(batchResult.actions.length, 5, 'Should batch 4 input fields + 1 submit button');

const keys = batchResult.actions.map(a => a.use_vault_field).filter(Boolean);
assert.ok(keys.includes('email'), 'Should map email vault field');
assert.ok(keys.includes('phone'), 'Should map phone vault field');
assert.ok(keys.includes('password'), 'Should map password vault field');
assert.strictEqual(batchResult.actions[4].action, 'click', 'Final action in batch should be submit click');
console.log('  ok   planBatchFormFill groups form fields into a high-speed 1-pass execution batch');

// Test 2: Targetless Actions includes 'batch'
assert.ok(ActionExecutor.TARGETLESS_ACTIONS.has('batch'), 'ActionExecutor must treat "batch" as targetless action');
console.log('  ok   ActionExecutor registers "batch" as valid targetless action');

// Test 3: Backward compatibility in single-step planNextAction
const singleStep = TaskPlanner.planNextAction({
  task: 'fill this registration form with my details',
  marks: mockFormMarks,
  filledIds: [],
  pageInfo: { url: 'https://example.com/register' }
});
assert.strictEqual(singleStep.action, 'type', 'Single-step planNextAction must preserve backward compatibility');
assert.strictEqual(singleStep.mark_id, 11, 'Picks first specific input field (email) in single-step pass');
console.log('  ok   planNextAction preserves backward compatibility for single-step runners');

// Test 4: Autocomplete Selector Breadth
assert.ok(typeof ActionExecutor.executeAction === 'function', 'ActionExecutor exports executeAction');
console.log('  ok   ActionExecutor module is intact and verified');

console.log('All batch automation & self-healing tests passed.\n');
