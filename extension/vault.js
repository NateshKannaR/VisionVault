/**
 * vault.js — Privacy Vault Manager
 *
 * Wrapper around chrome.storage.local for storing and retrieving user's own real values:
 * name, email, phone, address, username, password, company, zip, about.
 *
 * Real values are resolved strictly locally on-device and never transmitted over the network.
 */

(function (global) {
  const VAULT_KEY_MAP = {
    email: "email",
    mail: "email",
    "email-address": "email",
    phone: "phone",
    tel: "phone",
    mobile: "phone",
    name: "name",
    fullname: "name",
    "full-name": "name",
    username: "username",
    user: "username",
    address: "address",
    street: "address",
    "street-address": "address",
    company: "company",
    org: "company",
    zip: "zip",
    postal: "zip",
    "postal-code": "zip",
    password: "password",
    passwd: "password",
    pass: "password",
    about: "about",
    bio: "about",
    description: "about"
  };

  /**
   * Retrieves the local vault object from chrome.storage.local.
   */
  async function getVault() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      return {};
    }
    const data = await chrome.storage.local.get("vault");
    return data.vault || {};
  }

  /**
   * Saves the vault object into chrome.storage.local.
   */
  async function saveVault(vaultData) {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      return false;
    }
    await chrome.storage.local.set({ vault: vaultData });
    return true;
  }

  /**
   * Resolves a vault field type to the user's stored real value.
   * Used ONLY locally when executing a type action referencing use_vault_field.
   *
   * @param {string} fieldType - The field key (e.g., "email", "phone", "name", "address")
   * @returns {Promise<string>} The user's real personal value
   */
  async function resolveVaultField(fieldType) {
    if (!fieldType) return "";
    const vault = await getVault();
    const normalizedKey = (fieldType || "").toLowerCase().trim();
    const mappedKey = VAULT_KEY_MAP[normalizedKey] || normalizedKey;
    return vault[mappedKey] || "";
  }

  /**
   * Generates a secure random 16-byte hex salt string.
   */
  function generateSalt() {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    if (typeof require !== "undefined") {
      try {
        const nodeCrypto = require("crypto");
        return nodeCrypto.randomBytes(16).toString("hex");
      } catch (e) {
        // Fallback
      }
    }
    let s = "";
    for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  /**
   * Computes SHA-256 hash of salt + pin.
   *
   * @param {string} pin - Plaintext PIN
   * @param {string} salt - Hex salt string
   * @returns {Promise<string>} Hex-encoded SHA-256 digest
   */
  async function hashPin(pin, salt) {
    const text = (salt || "") + (pin || "");
    if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
      const enc = new TextEncoder();
      const data = enc.encode(text);
      const hashBuf = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    if (typeof require !== "undefined") {
      try {
        const nodeCrypto = require("crypto");
        return nodeCrypto.createHash("sha256").update(text).digest("hex");
      } catch (e) {
        // Fallback
      }
    }
    throw new Error("Cryptographic hash function unavailable");
  }

  /**
   * Checks whether a vault PIN has been configured in local storage.
   *
   * @returns {Promise<boolean>}
   */
  async function hasVaultPin() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      return false;
    }
    const data = await chrome.storage.local.get(["vaultPinHash", "vaultSalt"]);
    return Boolean(data.vaultPinHash && data.vaultSalt);
  }

  /**
   * Verifies a provided PIN against the stored salt + SHA-256 hash.
   * If no PIN has been set, returns true.
   *
   * @param {string} pin
   * @returns {Promise<boolean>}
   */
  async function verifyVaultPin(pin) {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      return false;
    }
    const data = await chrome.storage.local.get(["vaultPinHash", "vaultSalt"]);
    if (!data.vaultPinHash || !data.vaultSalt) {
      return true; // No PIN configured
    }
    if (!pin) return false;
    const computed = await hashPin(pin, data.vaultSalt);
    return computed === data.vaultPinHash;
  }

  /**
   * Sets or updates the vault PIN.
   *
   * @param {string} pin - The new PIN (minimum 4 characters)
   * @returns {Promise<boolean>}
   */
  async function setVaultPin(pin) {
    if (!pin || typeof pin !== "string" || pin.trim().length < 4) {
      throw new Error("Vault PIN must be at least 4 characters long");
    }
    const salt = generateSalt();
    const hash = await hashPin(pin.trim(), salt);
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ vaultPinHash: hash, vaultSalt: salt });
    }
    return true;
  }

  /**
   * Removes the vault PIN protection after verifying the current PIN.
   *
   * @param {string} currentPin - The current PIN for confirmation
   * @returns {Promise<boolean>}
   */
  async function removeVaultPin(currentPin) {
    const hasPin = await hasVaultPin();
    if (!hasPin) return true;
    const ok = await verifyVaultPin(currentPin);
    if (!ok) {
      throw new Error("Incorrect current PIN");
    }
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.remove(["vaultPinHash", "vaultSalt"]);
    }
    return true;
  }

  const VaultManager = {
    getVault,
    saveVault,
    resolveVaultField,
    generateSalt,
    hashPin,
    hasVaultPin,
    verifyVaultPin,
    setVaultPin,
    removeVaultPin,
    VAULT_KEY_MAP
  };

  global.VaultManager = VaultManager;
  global.getVault = getVault;
  global.saveVault = saveVault;
  global.resolveVaultField = resolveVaultField;
  global.hasVaultPin = hasVaultPin;
  global.verifyVaultPin = verifyVaultPin;
  global.setVaultPin = setVaultPin;
  global.removeVaultPin = removeVaultPin;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = VaultManager;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
