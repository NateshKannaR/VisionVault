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

  // 9. AES-GCM-256 At-Rest Encryption & Plaintext Storage Elimination
  assert.strictEqual(store.vault, undefined, "Plaintext vault must NOT be written to chrome.storage.local");
  assert.strictEqual(typeof store.vaultEncrypted, "object", "Encrypted vault envelope must exist in storage");
  assert.strictEqual(store.vaultEncrypted.cipher, "AES-GCM-256");
  assert.strictEqual(store.vaultEncrypted.kdf, "PBKDF2-SHA256");
  assert.strictEqual(store.vaultEncrypted.iterations, 100000);
  assert.strictEqual(typeof store.vaultEncrypted.salt, "string");
  assert.strictEqual(store.vaultEncrypted.salt.length, 32, "Salt should be 16 bytes (32 hex characters)");
  assert.strictEqual(typeof store.vaultEncrypted.iv, "string");
  assert.strictEqual(store.vaultEncrypted.iv.length, 24, "IV should be 12 bytes (24 hex characters)");
  assert.strictEqual(typeof store.vaultEncrypted.ciphertext, "string");
  console.log("✔ AES-GCM-256: vault is encrypted at rest; plaintext storage eliminated");

  // 10. Direct AES-GCM Encrypt, Decrypt and Tamper Resistance
  const testSecret = { mission: "GAGANYAAN-01", key: "TOP-SECRET-KEY" };
  const env = await vm.encryptVaultData(testSecret, "secure-pass-777");
  assert.strictEqual(env.cipher, "AES-GCM-256");
  const dec = await vm.decryptVaultData(env, "secure-pass-777");
  assert.strictEqual(dec.mission, "GAGANYAAN-01");
  assert.strictEqual(dec.key, "TOP-SECRET-KEY");

  // Wrong password fails
  let decryptFailed = false;
  try {
    await vm.decryptVaultData(env, "wrong-pass");
  } catch (_) {
    decryptFailed = true;
  }
  assert.strictEqual(decryptFailed, true, "Decrypting with wrong passphrase must fail");

  // Bit flip / tampering detection (AES-GCM authentication tag verification)
  const tamperedCipher = (env.ciphertext.slice(0, -2) === "00" ? "ff" : "00") + env.ciphertext.slice(2);
  let tamperDetected = false;
  try {
    await vm.decryptVaultData({ ...env, ciphertext: tamperedCipher }, "secure-pass-777");
  } catch (_) {
    tamperDetected = true;
  }
  assert.strictEqual(tamperDetected, true, "Tampered ciphertext must fail authentication");
  console.log("✔ AES-GCM-256: authenticated encryption verified; tamper-resistance enforced");

  // 11. Encryption Status API
  const status = await vm.getVaultEncryptionStatus();
  assert.strictEqual(status.encrypted, true);
  assert.strictEqual(status.cipher, "AES-GCM-256");
  assert.strictEqual(status.iterations, 100000);
  // 12. Dynamic Vault Upgrades: setVaultField()
  await vm.setVaultField("pan", "ABCDE1234F");
  await vm.setVaultField("security_clearance", "LEVEL-5-COSMIC");
  const stored1 = await vm.getVault();
  assert.strictEqual(stored1.pan, "ABCDE1234F", "Newly added field 'pan' must be in vault");
  assert.strictEqual(stored1.security_clearance, "LEVEL-5-COSMIC", "Newly added field 'security_clearance' must be in vault");
  assert.strictEqual(await vm.resolveVaultField("pan"), "ABCDE1234F", "Custom field 'pan' must resolve");
  assert.strictEqual(await vm.resolveVaultField("security_clearance"), "LEVEL-5-COSMIC", "Custom field 'security_clearance' must resolve");
  console.log("✔ setVaultField(): dynamically stored new custom credentials into encrypted vault");

  // 13. Dynamic Vault Deletion: deleteVaultField()
  const deletedPan = await vm.deleteVaultField("pan");
  assert.strictEqual(deletedPan, true, "deleteVaultField should return true for existing field");
  const stored2 = await vm.getVault();
  assert.strictEqual(stored2.pan, undefined, "Deleted field 'pan' must no longer exist in vault");
  assert.strictEqual(stored2.security_clearance, "LEVEL-5-COSMIC", "Non-deleted fields must remain intact");
  assert.strictEqual(await vm.resolveVaultField("pan"), "", "Deleted field should resolve to empty string");
  console.log("✔ deleteVaultField(): successfully deleted specific credential from encrypted vault");

  // 14. Vault Reset: resetVaultToDefault()
  await vm.resetVaultToDefault();
  const defaultVault = await vm.getVault();
  assert.strictEqual(defaultVault.satellite_name, "INSAT-4B", "Reset vault must contain default satellite_name");
  assert.strictEqual(defaultVault.operator, "R. Sharma", "Reset vault must contain default operator");
  assert.strictEqual(defaultVault.security_clearance, undefined, "Custom fields must be cleared on reset");
  console.log("✔ resetVaultToDefault(): restored vault to default space mission profile");

  // 15. Vault Clear: clearVault()
  await vm.clearVault();
  const emptyVault = await vm.getVault();
  assert.deepStrictEqual(emptyVault, {}, "Cleared vault must be an empty object");
  console.log("✔ clearVault(): cleared all credentials from encrypted vault");

  console.log("\nAll Vault Lock, AES Encryption & Dynamic Field tests passed successfully (15/15)!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
