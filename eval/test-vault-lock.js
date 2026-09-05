#!/usr/bin/env node
/**
 * test-vault-lock.js — Verifies PIN locking, hashing, and resolution in vault.js.
 *
 * Run: node eval/test-vault-lock.js
 */

const assert = require("assert");
const vm = require("../extension/vault.js");

// Mock chrome.storage.local
const store = {};
global.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") {
          return { [keys]: store[keys] };
        }
        const res = {};
        for (const k of keys) {
          if (store[k] !== undefined) res[k] = store[k];
        }
        return res;
      },
      set: async (items) => {
        Object.assign(store, items);
      },
      remove: async (keys) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) {
          delete store[k];
        }
      }
    }
  }
};

async function runTests() {
  console.log("Running Vault Lock Tests...\n");

  // 1. Initial State
  const initialHasPin = await vm.hasVaultPin();
  assert.strictEqual(initialHasPin, false, "Initial vault should not have a PIN set");
  console.log("✔ Initial state: hasVaultPin() === false");

  // 2. Salt Generation
  const s1 = vm.generateSalt();
  const s2 = vm.generateSalt();
  assert.strictEqual(typeof s1, "string");
  assert.strictEqual(s1.length, 32, "Salt should be 32 hex chars (16 bytes)");
  assert.notStrictEqual(s1, s2, "Consecutive salts should be unique");
  console.log("✔ generateSalt(): generated unique 16-byte hex salts");

  // 3. Hash Pin
  const h1 = await vm.hashPin("1234", "salt123");
  const h2 = await vm.hashPin("1234", "salt123");
  const h3 = await vm.hashPin("12345", "salt123");
  assert.strictEqual(h1, h2, "Hash should be deterministic");
  assert.notStrictEqual(h1, h3, "Different PIN should produce different hash");
  assert.strictEqual(h1.length, 64, "SHA-256 hex string should be 64 characters");
  console.log("✔ hashPin(): computed correct SHA-256 digests");

  // 4. Set PIN validation
  let threw = false;
  try {
    await vm.setVaultPin("12");
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, true, "PIN under 4 characters must be rejected");
  console.log("✔ setVaultPin(): rejects PINs shorter than 4 characters");

  // 5. Setting valid PIN
  await vm.setVaultPin("9876");
  assert.strictEqual(await vm.hasVaultPin(), true, "Vault should have PIN after setVaultPin()");
  assert.strictEqual(typeof store.vaultPinHash, "string");
  assert.strictEqual(typeof store.vaultSalt, "string");
  console.log("✔ setVaultPin(): successfully set PIN and updated storage");

  // 6. Verification
  const correct = await vm.verifyVaultPin("9876");
  assert.strictEqual(correct, true, "Correct PIN must verify as true");
  const wrong = await vm.verifyVaultPin("0000");
  assert.strictEqual(wrong, false, "Wrong PIN must verify as false");
  const empty = await vm.verifyVaultPin("");
  assert.strictEqual(empty, false, "Empty PIN must verify as false");
  console.log("✔ verifyVaultPin(): verified correct PIN and rejected invalid PINs");

  // 7. Remove PIN
  let removeFailed = false;
  try {
    await vm.removeVaultPin("wrong-pin");
  } catch (e) {
    removeFailed = true;
  }
  assert.strictEqual(removeFailed, true, "Removing PIN with incorrect password must fail");

  await vm.removeVaultPin("9876");
  assert.strictEqual(await vm.hasVaultPin(), false, "PIN should be removed from vault");
  assert.strictEqual(store.vaultPinHash, undefined);
  assert.strictEqual(store.vaultSalt, undefined);
  console.log("✔ removeVaultPin(): removed PIN with correct password");

  // 8. Credential Storage and Background Resolution
  await vm.saveVault({
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+44 123456",
    password: "supersecretpassword123"
  });
  const resolvedEmail = await vm.resolveVaultField("email");
  const resolvedMail = await vm.resolveVaultField("mail");
  const resolvedPassword = await vm.resolveVaultField("password");
  assert.strictEqual(resolvedEmail, "ada@example.com");
  assert.strictEqual(resolvedMail, "ada@example.com");
  assert.strictEqual(resolvedPassword, "supersecretpassword123");
  console.log("✔ resolveVaultField(): personal credentials resolve safely and accurately");

  console.log("\nAll Vault Lock tests passed successfully (8/8)!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
