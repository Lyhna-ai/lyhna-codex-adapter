#!/usr/bin/env node
// Cold-check a window handoff chain, without an agent in the loop.
//
//   node scripts/verify-lineage.mjs <prior-run-dir> <current-run-dir> [...more]
//
// Given two or more run packet directories in the order the windows ran, verify each link: that
// each window committed, inside its own hash chain, to the exact capsule and carry-forward state
// its predecessor published — and that the predecessor's published capsule re-folds from its own
// ledger. A human can run this against the packets on disk and get a LINKED / NOT LINKED answer
// per hop, which is the thing no amount of reading handoff prose can tell you.
//
// Exit status is 0 only if every hop links.

import { renderLineageMarkdown, verifyLineage } from '../plugins/lyhna/src/lineage.mjs';

const packets = process.argv.slice(2);
if (packets.length < 2) {
  process.stderr.write('usage: node scripts/verify-lineage.mjs <prior-run-dir> <current-run-dir> [...more]\n');
  process.exit(2);
}

let allLinked = true;
for (let index = 0; index + 1 < packets.length; index += 1) {
  const report = verifyLineage(packets[index], packets[index + 1]);
  allLinked = allLinked && report.ok;
  process.stdout.write(`\n## Hop ${index + 1} of ${packets.length - 1}\n\n`);
  process.stdout.write(renderLineageMarkdown(report));
}

process.stdout.write(`\n**Chain result: ${allLinked ? 'LINKED' : 'NOT LINKED'}** across ${packets.length} window(s).\n`);
process.exit(allLinked ? 0 : 1);
