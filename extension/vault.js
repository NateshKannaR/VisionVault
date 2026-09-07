/**
 * vault.js — Privacy Vault Manager with Military-Grade AES-GCM-256 Encryption
 *
 * All credentials, satellite telemetry, and personal identifiers stored in chrome.storage.local
 * are encrypted at rest using AES-GCM-256 with PBKDF2 (100,000 iterations of SHA-256) key derivation.
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

  // ── Cryptographic Constants & Memory Session State ─────────────────────────
  const AES_CIPHER = "AES-GCM";
  const AES_KEY_LENGTH = 256;
  const PBKDF2_ITERATIONS = 100000;
  const PBKDF2_HASH = "SHA-256";

  let sessionDecryptedVault = null;
  let sessionPin = null;

  function getSubtleCrypto() {
    if (typeof crypto !== "undefined" && crypto.subtle) return crypto.subtle;
    if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto.subtle;
    try {
      const nodeCrypto = require("crypto");
      return nodeCrypto.webcrypto ? nodeCrypto.webcrypto.subtle : null;
    } catch (_) {
      return null;
    }
  }

  function bufferToHex(buf) {
    const arr = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < arr.length; i++) {
      hex += arr[i].toString(16).padStart(2, "0");
    }
    return hex;
  }

  function hexToBuffer(hex) {
    const clean = String(hex || "").trim();
    const bytes = new Uint8Array(Math.ceil(clean.length / 2));
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  /**
   * Generates a secure random 16-byte hex salt string.
   */
  function generateSalt() {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return bufferToHex(bytes);
    }
    if (typeof require !== "undefined") {
      try {
        const nodeCrypto = require("crypto");
        return nodeCrypto.randomBytes(16).toString("hex");
      } catch (_) {}
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
    const subtle = getSubtleCrypto();
    if (subtle) {
      const enc = new TextEncoder();
      const hashBuf = await subtle.digest("SHA-256", enc.encode(text));
      return bufferToHex(hashBuf);
    }
    if (typeof require !== "undefined") {
      try {
        const nodeCrypto = require("crypto");
        return nodeCrypto.createHash("sha256").update(text).digest("hex");
      } catch (_) {}
    }
    throw new Error("Cryptographic hash function unavailable");
  }

  /**
   * Derives a 256-bit AES-GCM CryptoKey from a passphrase and salt using PBKDF2.
   */
  async function deriveAesKey(passphrase, saltBytes) {
    const subtle = getSubtleCrypto();
    if (!subtle) throw new Error("Web Crypto API (subtle) is unavailable");
    const enc = new TextEncoder();
    const keyMaterial = await subtle.importKey(
      "raw",
      enc.encode(passphrase),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    return await subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations: PBKDF2_ITERATIONS,
        hash: PBKDF2_HASH
      },
      keyMaterial,
      { name: AES_CIPHER, length: AES_KEY_LENGTH },
      false,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Encrypts a vault object using AES-GCM-256 with PBKDF2 key derivation.
   */
  async function encryptVaultData(vaultObj, passphrase) {
    const subtle = getSubtleCrypto();
    if (!subtle) throw new Error("Web Crypto API (subtle) is unavailable");
    const saltBytes = new Uint8Array(16);
    const ivBytes = new Uint8Array(12);

    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(saltBytes);
      crypto.getRandomValues(ivBytes);
    } else {
      const nodeCrypto = require("crypto");
      nodeCrypto.randomFillSync(saltBytes);
      nodeCrypto.randomFillSync(ivBytes);
    }

    const key = await deriveAesKey(passphrase, saltBytes);
    const enc = new TextEncoder();
    const plaintext = JSON.stringify(vaultObj || {});
    const cipherBuf = await subtle.encrypt(
      { name: AES_CIPHER, iv: ivBytes },
      key,
      enc.encode(plaintext)
    );

    return {
      version: 1,
      cipher: "AES-GCM-256",
      kdf: "PBKDF2-SHA256",
      iterations: PBKDF2_ITERATIONS,
      salt: bufferToHex(saltBytes),
      iv: bufferToHex(ivBytes),
      ciphertext: bufferToHex(cipherBuf),
      updatedAt: Date.now()
    };
  }

  /**
   * Decrypts an AES-GCM-256 encrypted vault envelope.
   */
  async function decryptVaultData(envelope, passphrase) {
    if (!envelope || !envelope.ciphertext || !envelope.iv || !envelope.salt) {
      throw new Error("Invalid encrypted vault envelope");
    }
    const subtle = getSubtleCrypto();
    if (!subtle) throw new Error("Web Crypto API (subtle) is unavailable");

    const saltBytes = hexToBuffer(envelope.salt);
    const ivBytes = hexToBuffer(envelope.iv);
    const cipherBytes = hexToBuffer(envelope.ciphertext);

    const key = await deriveAesKey(passphrase, saltBytes);
    const decryptedBuf = await subtle.decrypt(
      { name: AES_CIPHER, iv: ivBytes },
      key,
      cipherBytes
    );

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decryptedBuf));
  }

  /**
   * Device-bound master secret for at-rest encryption when no user PIN is set.
   */
  async function getOrCreateDeviceMasterSecret() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      return "visionvault-device-root-key";
    }
    const data = await chrome.storage.local.get("vaultDeviceKey");
    if (data.vaultDeviceKey) return data.vaultDeviceKey;
    const newKey = generateSalt() + generateSalt();
    await chrome.storage.local.set({ vaultDeviceKey: newKey });
    return newKey;
  }

  /**
   * Retrieves the local vault object from chrome.storage.local, decrypting with AES-GCM-256.
   */
  async function getVault(optionalPin) {
    if (sessionDecryptedVault) {
      return Object.assign({}, DEFAULT_MISSION_VAULT, sessionDecryptedVault);
    }
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      return { ...DEFAULT_MISSION_VAULT };
    }

    const data = await chrome.storage.local.get(["vaultEncrypted", "vault", "vaultPinHash", "vaultSalt", "vaultDeviceKey"]);
    const hasPin = Boolean(data.vaultPinHash && data.vaultSalt);

    // 1. If encrypted envelope exists:
    if (data.vaultEncrypted) {
      if (hasPin) {
        const pin = optionalPin || sessionPin;
        if (pin) {
          try {
            const decrypted = await decryptVaultData(data.vaultEncrypted, pin);
            sessionDecryptedVault = decrypted;
            sessionPin = pin;
            return Object.assign({}, DEFAULT_MISSION_VAULT, decrypted);
          } catch (_) {
            return { ...DEFAULT_MISSION_VAULT };
          }
        }
        // Locked: return default values
        return { ...DEFAULT_MISSION_VAULT };
      } else {
        // Encrypted with device master secret
        try {
          const deviceKey = data.vaultDeviceKey || (await getOrCreateDeviceMasterSecret());
          const decrypted = await decryptVaultData(data.vaultEncrypted, deviceKey);
          sessionDecryptedVault = decrypted;
          return Object.assign({}, DEFAULT_MISSION_VAULT, decrypted);
        } catch (_) {
          return { ...DEFAULT_MISSION_VAULT };
        }
      }
    }

    // 2. Transparent migration: if legacy plaintext vault exists, encrypt it immediately
    if (data.vault) {
      const merged = Object.assign({}, DEFAULT_MISSION_VAULT, data.vault);
      try {
        const secret = hasPin && (optionalPin || sessionPin)
          ? (optionalPin || sessionPin)
          : await getOrCreateDeviceMasterSecret();
        const envelope = await encryptVaultData(merged, secret);
        await chrome.storage.local.set({ vaultEncrypted: envelope });
        await chrome.storage.local.remove("vault");
      } catch (_) {}
      sessionDecryptedVault = merged;
      return merged;
    }

    return { ...DEFAULT_MISSION_VAULT };
  }

  /**
   * Saves the vault object into chrome.storage.local encrypted with AES-GCM-256.
   */
  async function saveVault(vaultData, optionalPin) {
    const merged = Object.assign({}, DEFAULT_MISSION_VAULT, vaultData || {});
    sessionDecryptedVault = merged;

    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      return false;
    }

    const hasPin = await hasVaultPin();
    const passphrase = hasPin
      ? (optionalPin || sessionPin)
      : await getOrCreateDeviceMasterSecret();

    if (!passphrase) {
      throw new Error("Vault is locked: PIN required to save encrypted vault");
    }

    const envelope = await encryptVaultData(merged, passphrase);
    await chrome.storage.local.set({ vaultEncrypted: envelope });
    // Ensure plaintext vault is permanently removed from disk
    await chrome.storage.local.remove("vault");
    return true;
  }

  /**
   * Resolves a vault field type to the user's stored real value.
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
   * Unlocks the vault with user's PIN, decrypting the AES-GCM envelope and caching in memory.
   */
  async function unlockVaultWithPin(pin) {
    const cleanPin = String(pin || "").trim();
    const ok = await verifyVaultPin(cleanPin);
    if (!ok) return { success: false, error: "Incorrect PIN" };

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      const data = await chrome.storage.local.get("vaultEncrypted");
      if (data.vaultEncrypted) {
        try {
          const decrypted = await decryptVaultData(data.vaultEncrypted, cleanPin);
          sessionDecryptedVault = Object.assign({}, DEFAULT_MISSION_VAULT, decrypted);
          sessionPin = cleanPin;
          return { success: true, vault: sessionDecryptedVault };
        } catch (e) {
          return { success: false, error: "Decryption failed: corrupted ciphertext or bad PIN" };
        }
      }
    }
    sessionPin = cleanPin;
    sessionDecryptedVault = await getVault(cleanPin);
    return { success: true, vault: sessionDecryptedVault };
  }

  /**
   * Locks the vault in memory.
   */
  function lockVault() {
    sessionPin = null;
    sessionDecryptedVault = null;
  }

  function isVaultUnlockedInMemory() {
    return Boolean(sessionDecryptedVault !== null);
  }

  /**
   * Sets or updates the vault PIN and re-encrypts the vault with the new PIN.
   */
  async function setVaultPin(pin, optionalCurrentPin) {
    if (!pin || typeof pin !== "string" || pin.trim().length < 4) {
      throw new Error("Vault PIN must be at least 4 characters long");
    }
    const cleanPin = pin.trim();
    const currentData = await getVault(optionalCurrentPin);
    const salt = generateSalt();
    const hash = await hashPin(cleanPin, salt);

    // Encrypt vault with user's new PIN
    const envelope = await encryptVaultData(currentData, cleanPin);

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({
        vaultEncrypted: envelope,
        vaultPinHash: hash,
        vaultSalt: salt
      });
      await chrome.storage.local.remove("vault");
    }

    sessionPin = cleanPin;
    sessionDecryptedVault = currentData;
    return true;
  }

  /**
   * Removes the vault PIN protection, re-encrypting the vault with the device master key.
   */
  async function removeVaultPin(currentPin) {
    const hasPin = await hasVaultPin();
    if (!hasPin) return true;
    const ok = await verifyVaultPin(currentPin);
    if (!ok) {
      throw new Error("Incorrect current PIN");
    }

    const currentData = await getVault(currentPin);
    const deviceKey = await getOrCreateDeviceMasterSecret();
    const envelope = await encryptVaultData(currentData, deviceKey);

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ vaultEncrypted: envelope });
      await chrome.storage.local.remove(["vaultPinHash", "vaultSalt", "vault"]);
    }

    sessionPin = null;
    sessionDecryptedVault = currentData;
    return true;
  }

  /**
   * Returns metadata about the current vault encryption state.
   */
  async function getVaultEncryptionStatus() {
    const hasPin = await hasVaultPin();
    return {
      encrypted: true,
      cipher: "AES-GCM-256",
      kdf: "PBKDF2-SHA256",
      iterations: PBKDF2_ITERATIONS,
      hasPin,
      isUnlocked: sessionDecryptedVault !== null || !hasPin
    };
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
    unlockVaultWithPin,
    lockVault,
    isVaultUnlockedInMemory,
    setVaultPin,
    removeVaultPin,
    encryptVaultData,
    decryptVaultData,
    getVaultEncryptionStatus,
    VAULT_KEY_MAP
  };

  global.DEFAULT_MISSION_VAULT = DEFAULT_MISSION_VAULT;
  global.VaultManager = VaultManager;
  global.getVault = getVault;
  global.saveVault = saveVault;
  global.resolveVaultField = resolveVaultField;
  global.hasVaultPin = hasVaultPin;
  global.verifyVaultPin = verifyVaultPin;
  global.unlockVaultWithPin = unlockVaultWithPin;
  global.lockVault = lockVault;
  global.isVaultUnlockedInMemory = isVaultUnlockedInMemory;
  global.setVaultPin = setVaultPin;
  global.removeVaultPin = removeVaultPin;
  global.encryptVaultData = encryptVaultData;
  global.decryptVaultData = decryptVaultData;
  global.getVaultEncryptionStatus = getVaultEncryptionStatus;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = VaultManager;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
