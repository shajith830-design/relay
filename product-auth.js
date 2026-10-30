"use strict";

const {
  randomBytes,
  scrypt: scryptCallback,
  timingSafeEqual
} = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(scryptCallback);

async function makePasswordHash(password) {
  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

async function checkPassword(password, encodedHash) {
  const [algorithm, saltHex, keyHex] = encodedHash.split(":");
  if (algorithm !== "scrypt" || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(keyHex)) {
    return false;
  }
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

module.exports = { makePasswordHash, checkPassword };
