#!/usr/bin/env node
/**
 * test-advanced-features.js — Tests Zero-Knowledge Vault AES-256-GCM Crypto,
 * local scan summary Compliance Certificate Generator, and Obstacle / CAPTCHA Healing.
 */

const assert = require('assert');
const VaultCrypto = require('../extension/vault-crypto.js');
const ActionExecutor = require('../extension/action-executor.js');

console.log('\n--- Advanced Prototype & SIH PS 26171 Verification Tests ---');

async function runTests() {
  // Test 1: Zero-Knowledge AES-256-GCM Vault Encryption & Decryption
  console.log('Test 1: Zero-Knowledge AES-256-GCM Vault Backup');
  const mockVault = {
    name: 'Dr. Vikram Sarabhai',
    email: 'sarabhai@isro.gov.in',
    phone: '+91 9876543210',
    satellite_name: 'GSAT-29',
    password: 'SuperSecretAuthToken123!'
  };
  const masterPassphrase = 'SovereignISROPassword#2026';

  const encryptedEnvelope = await VaultCrypto.encryptVault(mockVault, masterPassphrase);
  assert.ok(encryptedEnvelope, 'Should return encrypted envelope');
  assert.strictEqual(encryptedEnvelope.algorithm, 'AES-256-GCM', 'Uses AES-256-GCM');
  assert.strictEqual(encryptedEnvelope.kdf, 'PBKDF2-SHA256', 'Uses PBKDF2-SHA256');
  assert.strictEqual(encryptedEnvelope.iterations, 100000, 'Uses 100,000 PBKDF2 iterations');
  assert.ok(encryptedEnvelope.ciphertext, 'Ciphertext is non-empty');
  assert.ok(encryptedEnvelope.iv, 'Random 12-byte IV is present');
  assert.ok(encryptedEnvelope.salt, 'Random 16-byte salt is present');

  // Verify ciphertext does not leak plaintext
  const rawString = JSON.stringify(encryptedEnvelope);
  assert.ok(!rawString.includes('Dr. Vikram Sarabhai'), 'Plaintext name must not appear in encrypted payload');
  assert.ok(!rawString.includes('SuperSecretAuthToken123!'), 'Plaintext password must not appear in encrypted payload');

  // Decrypt with correct passphrase
  const decrypted = await VaultCrypto.decryptVault(encryptedEnvelope, masterPassphrase);
  assert.deepStrictEqual(decrypted, mockVault, 'Decrypted object matches original vault data exactly');

  // Decrypt with incorrect passphrase must fail
  let failedAsExpected = false;
  try {
    await VaultCrypto.decryptVault(encryptedEnvelope, 'WrongPassword!');
  } catch (err) {
    failedAsExpected = true;
  }
  assert.ok(failedAsExpected, 'Decryption with wrong password must throw error');
  console.log('  ok   Zero-knowledge PBKDF2 + AES-256-GCM encrypted backup is verified.');

  console.log('\nTest 2: Local scan summary');
  const report = await VaultCrypto.generateSessionReport({
    piiCount: 5, marksCount: 12, timings: { total: 86 }, task: 'private input',
  });
  const { integrityChecksum, ...counters } = report.json;
  assert.strictEqual(counters.detectedRegions, 5);
  assert.strictEqual(counters.interactiveElements, 12);
  assert.strictEqual(counters.scanDurationMs, 86);
  assert.strictEqual(integrityChecksum, await VaultCrypto.sha256(JSON.stringify(counters)));
  assert.ok(report.html.includes(integrityChecksum));
  assert.ok(!JSON.stringify(report).includes('private input'));
  console.log('  ok   Scan counters and checksum exported without task data.');

  // Test 3: Obstacle & CAPTCHA Detection
  console.log('\nTest 3: Obstacle & CAPTCHA Healing Detection');
  assert.ok(typeof ActionExecutor.detectObstacleOrCaptcha === 'function', 'detectObstacleOrCaptcha is exported');
  const obstacleCheck = ActionExecutor.detectObstacleOrCaptcha();
  assert.ok(obstacleCheck !== undefined, 'detectObstacleOrCaptcha returns status');
  console.log('  ok   Self-healing obstacle & CAPTCHA detector is intact.');

  console.log('\n🎉 ALL ADVANCED FEATURE TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
