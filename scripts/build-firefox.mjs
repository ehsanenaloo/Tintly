import { writePackage } from './lib/package-files.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const { file, bytes, version } = writePackage('firefox');
const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
console.log(`firefox ${version}: ${file} (${bytes} bytes)\nsha256 ${sha}`);
