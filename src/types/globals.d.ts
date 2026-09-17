import type { Bridge } from '../shared/protocol.ts';

declare global {
  interface Window {
    /**
     * The bridge, handed from the document_start injection to the
     * document_idle one. Two content scripts in one isolated world share a
     * window, not a module graph, so this is the handoff.
     */
    TVAgentBridge?: Bridge;
    __tvAgentPanelLoaded?: boolean;
  }
}

export {};
