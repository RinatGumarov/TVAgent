/** TVAgent — the shapes both page worlds agree on. */

/** What the driver reports about the chart it found. */
export interface ProbeReport {
  tradingViewApi: boolean;
  loggedIn: boolean;
  /** The chart object exists. */
  chart: boolean;
  /** The chart answers, which it does not while TradingView is still loading. */
  ready: boolean;
  series: boolean;
  studies: boolean;
  drawings: boolean;
  pine: boolean;
  strategy: boolean;
  symbol: string | null;
  resolution: string | null;
  price?: number;
  warnings: string[];
}

/** All the driver could say when it never became ready. */
export type PartialProbeReport = Partial<ProbeReport> & { warnings: string[] };

/** Driver-pushed events. Unlike call(), these arrive unsolicited. */
export interface BridgeEvents {
  'chart-changed': ProbeReport;
  'widgetbar-active': { active: boolean };
}

export interface Bridge {
  call<T = unknown>(method: string, params?: object, timeout?: number): Promise<T>;
  on<K extends keyof BridgeEvents>(type: K, handler: (payload: BridgeEvents[K]) => void): void;
  probeWhenReady(attempts?: number): Promise<ProbeReport | PartialProbeReport>;
}
