/**
 * vault.js — Privacy Vault Manager
 *
 * Wrapper around chrome.storage.local for storing and retrieving user's own real values:
 * Satellite telemetry, mission parameters, and personal credentials.
 *
 * Real values are resolved strictly locally on-device and never transmitted over the network.
 */

(function (global) {
  const DEFAULT_MISSION_VAULT = {
    satellite_name: "INSAT-4B",
    mission_id: "INSAT-4B / M-201",
    operator: "R. Sharma",
    launch_date: "2007-03-12",
    orbit_type: "Geostationary (GEO)",
    orbital_inclination: "0.05°",
    apogee: "35,786 km",
    perigee: "35,786 km",
    tle_line_1: "1 30798U 07007A 26248.51249811 -.00000124 00000-0 10000-4 0 9991",
    tle_line_2: "2 30798 0.0512 87.2145 0001248 145.2104 214.8901 1.00273412 71234",
    ground_station_freq: "14.250 GHz (Ku-Band)",
    encryption_key_ref: "ISRO-KMS-EK-2026-04871",
    name: "R. Sharma",
    email: "r.sharma@isro.gov.in",
    username: "rsharma_mcc",
    phone: "+91 80 2217 2296",
    company: "ISRO Master Control Facility (MCF)",
    address: "MCF Salgame Road, Hassan, Karnataka, India",
    zip: "573201",
    password: "ISRO-MCF-SECURE-AUTH-2026",
    about: "Senior Mission Operations Controller — INSAT / GSAT Series"
  };

  const VAULT_KEY_MAP = {
    // satellite & telemetry
    satellite_name: "satellite_name",
    satellite: "satellite_name",
    sat_name: "satellite_name",
    "satellite-name": "satellite_name",
    mission_id: "mission_id",
    mission: "mission_id",
    "mission-id": "mission_id",
    operator: "operator",
    operator_name: "operator",
    "operator on duty": "operator",
    "operator-name": "operator",
    duty: "operator",
    launch_date: "launch_date",
    "launch-date": "launch_date",
    orbit_type: "orbit_type",
    "orbit-type": "orbit_type",
    orbit: "orbit_type",
    orbital_inclination: "orbital_inclination",
    inclination: "orbital_inclination",
    "orbital-inclination": "orbital_inclination",
    apogee: "apogee",
    perigee: "perigee",
    tle_line_1: "tle_line_1",
    "tle-line-1": "tle_line_1",
    tle1: "tle_line_1",
    tle_line_2: "tle_line_2",
    "tle-line-2": "tle_line_2",
    tle2: "tle_line_2",
    ground_station_freq: "ground_station_freq",
    "ground-station-freq": "ground_station_freq",
    frequency: "ground_station_freq",
    freq: "ground_station_freq",
    encryption_key_ref: "encryption_key_ref",
    "encryption-key-ref": "encryption_key_ref",
    encryption_key: "encryption_key_ref",
    key_ref: "encryption_key_ref",
    // contact & personal
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
   * Retrieves the local vault object from chrome.storage.local, defaulting to satellite telemetry.
   */
  async function getVault() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      return { ...DEFAULT_MISSION_VAULT };
    }
    const data = await chrome.storage.local.get("vault");
    const merged = Object.assign({}, DEFAULT_MISSION_VAULT, data.vault || {});
    return merged;
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
   * @param {string} fieldType - The field key (e.g., "satellite_name", "operator", "apogee", "email")
   * @returns {Promise<string>} The user's real personal value
   */
  async function resolveVaultField(fieldType) {
    if (!fieldType) return "";
    const vault = await getVault();
    const normalizedKey = (fieldType || "").toLowerCase().trim().replace(/[\s-]+/g, "_");
    const directKey = (fieldType || "").toLowerCase().trim();
    const mappedKey = VAULT_KEY_MAP[normalizedKey] || VAULT_KEY_MAP[directKey] || normalizedKey;
    return vault[mappedKey] || vault[directKey] || "";
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
    DEFAULT_MISSION_VAULT,
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

  global.DEFAULT_MISSION_VAULT = DEFAULT_MISSION_VAULT;
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
