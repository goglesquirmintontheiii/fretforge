// Usage: tsx scripts/compile-nam.ts model.nam outPrefix  -> outPrefix.code.i32, outPrefix.weights.f32, prints info
import { readFileSync, writeFileSync } from 'node:fs';
import { compileNam } from '../../shared/src/nam';
const [file, prefix] = process.argv.slice(2);
const c = compileNam(readFileSync(file, 'utf8'));
writeFileSync(`${prefix}.code.i32`, Buffer.from(c.code.buffer));
writeFileSync(`${prefix}.weights.f32`, Buffer.from(c.weights.buffer));
console.log(JSON.stringify(c.info));
