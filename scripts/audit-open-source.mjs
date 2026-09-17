#!/usr/bin/env node

// A conservative path inventory for the current working tree. This is not a
// legal review, secret scanner, or permission to publish files it does not flag.
import { execFileSync } from 'node:child_process';

const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean).map(name => name.replaceAll('\\', '/'));
const unique = [...new Set(names)].sort();

const blocked = [
  [/^assets\/maintenance-r(?:17|18|19)\//, 'R17–R19 character provenance limits public redistribution'],
  [/^assets\/companions\/(?:companion|home)\.(?:sadako|kunkun)\//, 'historical character likeness/name rights need review'],
  [/^assets\/companions\/blender-source\/(?:sadako|kunkun)\.blend$/, 'historical character source art needs review'],
  [/^docs\/steam-v1\/reference\//, 'reference art requires individual publication permission'],
  [/^artifacts\//, 'development archives must not be published without a contents review'],
];
const review = [
  [/^assets\/maintenance-r(?:15|16)\//, 'development character/source asset licensing'],
  [/^assets\/branding\//, 'branding art has no standalone release license record'],
  [/^assets\/companions\//, 'legacy companion assets need individual review'],
  [/^docs\/steam-v1\/evidence\//, 'evidence may contain private paths, screenshots, or restricted art'],
  [/^output\//, 'generated output should normally stay local'],
  [/^\.local-native-|^\.steam-native-/, 'local native builds should stay local'],
];

function collect(rules) {
  return rules.map(([pattern, reason]) => ({ reason, files: unique.filter(name => pattern.test(name)) }))
    .filter(item => item.files.length);
}
for (const [label, findings] of [['BLOCK', collect(blocked)], ['REVIEW', collect(review)]]) {
  for (const { reason, files } of findings) {
    console.log(`${label}: ${reason} (${files.length} files)`);
    for (const name of files.slice(0, 5)) console.log(`  ${name}`);
    if (files.length > 5) console.log(`  … ${files.length - 5} more`);
  }
}
console.log(`Inspected ${unique.length} tracked/staged or unignored files.`);
if (collect(blocked).length) {
  console.error('Public upload blocked: remove, replace, or explicitly clear the listed assets and review the resulting Git history.');
  process.exitCode = 1;
}
