/**
 * ISOLATED world, document_start.
 *
 * The panel bundle is a separate injection into this same world: it shares
 * this window, not this module graph, so the bridge is handed over on it.
 */
import { createBridge } from '../content/bridge.ts';

window.TVAgentBridge = createBridge();
