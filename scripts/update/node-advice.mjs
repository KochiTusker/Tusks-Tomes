/*
 * Prints upgrade advice when the Node.js running it is older than this tree
 * supports, and nothing otherwise. Always exits 0.
 *
 * apply.sh and apply.ps1 run it after a pull, with the `node` on PATH: that
 * is the Node that will run npm install and the restarted app, and the
 * minimum it is checked against is the one in the tree just pulled.
 */

import { nodeUpgradeAdvice } from '../setup/node-version.mjs'

const advice = nodeUpgradeAdvice(process.versions.node, process.platform)
if (advice) console.log(advice.join('\n'))
