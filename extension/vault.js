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

  const VaultManager = {
    getVault,
    saveVault,
    resolveVaultField,
    VAULT_KEY_MAP
  };

  global.VaultManager = VaultManager;
  global.getVault = getVault;
  global.saveVault = saveVault;
  global.resolveVaultField = resolveVaultField;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = VaultManager;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
