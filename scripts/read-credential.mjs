#!/usr/bin/env node
// Read ONE credential value from a YAML-ish credential store and print nothing else.            #56
//
// The rig needs the maintainer's route key to RECORD against a real model, and the scratch distiller must pass
// it into a clone that has no ambient profile. The project rule is absolute: raw tokens never appear in command
// output, never in logs, never in an error message. So this is a separate executable with a single narrow job —
// no shell quoting (my first attempt embedded a JS regex inside a bash string and shipped a syntax error), and
// no printing of anything except the one value the caller asked for.
//
// Usage: node scripts/read-credential.mjs <file> <KEY_NAME>
// Prints the value with no trailing newline; exits 1 (silently) if it is not present.
import fs from 'node:fs'

const [file, key] = process.argv.slice(2)
if (file === undefined || key === undefined) process.exit(1)

let text
try { text = fs.readFileSync(file, 'utf8') } catch { process.exit(1) }

// `KEY: value`, `KEY: "value"`, or a nested `  - KEY: value`; first hit wins.
const pattern = new RegExp(`${key}\\s*:\\s*"?([^"'\\n]+?)"?\\s*(?:#.*)?$`, 'm')
const found = pattern.exec(text)
if (found === null || found[1] === undefined || found[1].trim() === '') process.exit(1)
process.stdout.write(found[1].trim())
