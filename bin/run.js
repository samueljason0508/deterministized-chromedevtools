#!/usr/bin/env node
import { readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../src/drivers/', import.meta.url));
const [name, flag, inputPath] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(name || '') || flag !== '--input' || !inputPath) {
  console.error('Usage: node bin/run.js <app>/<driver> --input <request.json|->');
  process.exit(2);
}
const driverPath = resolve(root, `${name}.js`);
try {
  await access(driverPath);
  const input = JSON.parse(inputPath === '-' ? await new Promise((resolveInput, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { text += chunk; });
    process.stdin.on('end', () => resolveInput(text));
    process.stdin.on('error', reject);
  }) : await readFile(inputPath, 'utf8'));
  const driver = await import(pathToFileURL(driverPath).href);
  driver.validate(input);
  const script = `import { run } from ${JSON.stringify(pathToFileURL(driverPath).href)};\n` +
    `const result = await run(page, ${JSON.stringify(input)});\n` +
    'console.log(JSON.stringify(result));\n';
  const child = spawn('chrome-devtools-axi', ['run'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE') console.error(error.message);
  });
  child.stdin.end(script);
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('close', code => { if (code) process.exitCode = code; });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
