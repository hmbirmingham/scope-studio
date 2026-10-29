#!/usr/bin/env node
import main from '../src/cli/index.js';

main(process.argv.slice(2)).catch((err) => {
  process.exitCode = 1;
  console.error(`scope: ${err.message}`);
});
