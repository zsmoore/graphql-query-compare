import compare from './lib/compare.js';
import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const filePath1 = args[0];
const filePath2 = args[1];
const fileAsString1 = readFileSync(filePath1).toString();
const fileAsString2 = readFileSync(filePath2).toString();
compare(fileAsString1, fileAsString2);
export default compare;
