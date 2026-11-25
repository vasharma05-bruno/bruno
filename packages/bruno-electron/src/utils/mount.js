const fs = require('node:fs');
const crypto = require('node:crypto');
const { posixifyPath } = require('./filesystem');

const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex');
const hashFile = (absPath) => sha256(fs.readFileSync(absPath));
const hashFileAsync = async (absPath) => sha256(await fs.promises.readFile(absPath));
const idForAbsolutePath = (absolutePath) => sha256(posixifyPath(absolutePath)).slice(0, 21);
const uidForSeed = (seed) => sha256(seed).slice(0, 21);

module.exports = {
  hashFile,
  hashFileAsync,
  idForAbsolutePath,
  uidForSeed
};
