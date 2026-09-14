#!/usr/bin/env node
/**
 * test-screen-classifier.js — Verifies client-side screen state classification.
 */

const assert = require('assert');
const path = require('path');
const ScreenClassifier = require('../extension/vision/screenClassifier.js');

console.log('\n--- Client-Side Screen State Classifier ---');

// Test 1: Authentication Screen
const authState = ScreenClassifier.classifyScreenState({
  marks: [
    { id: 1, role: 'input', label: 'Email', tag: 'input' },
    { id: 2, role: 'input', label: 'Password', type: 'password', tag: 'input' },
    { id: 3, role: 'button', label: 'Sign In', tag: 'button' }
  ],
  pageInfo: { title: 'Sign In to Your Account', url_path: '/login' }
});
assert.strictEqual(authState.category, ScreenClassifier.SCREEN_TYPES.AUTHENTICATION);
assert.strictEqual(authState.recommendedStrategy, 'vault_credentials_only');
console.log('  ok   correctly classifies authentication screen state');

// Test 2: Form Submission Screen
const formState = ScreenClassifier.classifyScreenState({
  marks: [
    { id: 1, role: 'input', label: 'Full Name', tag: 'input' },
    { id: 2, role: 'input', label: 'Address', tag: 'input' },
    { id: 3, role: 'input', label: 'City', tag: 'input' },
    { id: 4, role: 'input', label: 'Postal Code', tag: 'input' },
    { id: 5, role: 'button', label: 'Submit Application', tag: 'button' }
  ],
  pageInfo: { title: 'Employee Registration Form', url_path: '/register' }
});
assert.strictEqual(formState.category, ScreenClassifier.SCREEN_TYPES.FORM_SUBMISSION);
assert.strictEqual(formState.recommendedStrategy, 'vault_autofill_pipeline');
console.log('  ok   correctly classifies multi-field form submission screen');

// Test 3: E-Commerce Checkout Screen
const cartState = ScreenClassifier.classifyScreenState({
  marks: [
    { id: 1, role: 'button', label: 'Proceed to Checkout', tag: 'button' },
    { id: 2, role: 'button', label: 'Apply Coupon', tag: 'button' },
    { id: 3, role: 'link', label: 'View Cart', tag: 'a' }
  ],
  pageInfo: { title: 'Shopping Cart — 2 Items', url_path: '/cart' }
});
assert.strictEqual(cartState.category, ScreenClassifier.SCREEN_TYPES.ECOMMERCE_CHECKOUT);
assert.strictEqual(cartState.recommendedStrategy, 'confirm_sensitive_actions');
console.log('  ok   correctly classifies e-commerce checkout screen');

// Test 4: Search Directory Screen
const searchState = ScreenClassifier.classifyScreenState({
  marks: Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    role: i === 0 ? 'input' : 'link',
    label: i === 0 ? 'Search products' : `Item ${i}`,
    tag: i === 0 ? 'input' : 'a'
  })),
  pageInfo: { title: 'Search Results for Headphones', url_path: '/search' }
});
assert.strictEqual(searchState.category, ScreenClassifier.SCREEN_TYPES.SEARCH_DIRECTORY);
assert.strictEqual(searchState.recommendedStrategy, 'fast_on_device_search');
console.log('  ok   correctly classifies search results directory screen');

console.log('All 4 screen classification tests passed.\n');
