/**
 * TVAgent — TradingView's in-page API, as far as the driver uses it.
 *
 * TradingView publishes no types for this. What is declared here is exactly
 * what src/injected/driver.ts calls and nothing more, so a call the driver
 * invents is a typecheck failure rather than a silent `any`.
 */

/** TradingView's observable: read it, and subscribe for changes. */
export interface WatchedValue<T> {
  value(): T;
  setValue?(next: T): void;
  subscribe(handler: (value: T) => void): void;
  unsubscribe(handler: (value: T) => void): void;
}

/** A chart event source; `subscribe` takes an owner slot the driver leaves null. */
export interface ChartSubscription {
  subscribe(owner: unknown, handler: () => void): void;
}

/** The OHLCV window TradingView keeps in memory (~300 bars). */
export interface Bars {
  isEmpty(): boolean;
  size(): number;
  last(): { value: number[] } | null;
  valueAt(index: number): number[] | null;
  firstIndex(): number;
  lastIndex(): number;
}

export interface Series {
  data(): { bars(): Bars };
}

/** The inner study object a strategy's report hangs off. */
export interface StrategyStudy {
  reportData?(): unknown;
}

export interface Study {
  study?(): StrategyStudy | null;
  reportData?(): unknown;
  getInputValues?(): unknown;
  setInputValues?(values: Array<{ id: string; value: unknown }>): void;
  hasError?(): boolean;
  status?(): unknown;
}

/** One entry from the indicator catalog. */
export interface StudyMetaInfo {
  id: string;
  description: string;
  shortDescription: string;
}

export interface StudyMetaRepository {
  getInternalMetaInfoArray(): StudyMetaInfo[];
}

export interface VisibleRange {
  from: number;
  to: number;
}

export interface Chart {
  symbol(): string;
  symbolExt(): { symbol?: string; full_name?: string; description?: string } | null;
  resolution(): string;
  setSymbol(symbol: string): Promise<boolean>;
  setResolution(resolution: string): Promise<boolean>;
  chartType(): number | string;
  getSeries(): Series;
  getVisibleRange(): VisibleRange;
  setVisibleRange(range: VisibleRange): Promise<void>;

  createStudy(
    name: string,
    overlay: boolean,
    lock: boolean,
    inputs?: Record<string, unknown>,
  ): Promise<string | null>;
  waitForStudyCreated(id: string): Promise<void>;
  getAllStudies(): Array<{ id: string; name: string }>;
  getStudyById(id: string): Study | null;
  studyMetaIntoRepository?(): StudyMetaRepository | null;

  createShape(point: Record<string, unknown>, options: Record<string, unknown>): Promise<string>;
  createMultipointShape(
    points: Array<Record<string, unknown>>,
    options: Record<string, unknown>,
  ): Promise<string>;
  getAllShapes(): Array<{ id: string; name: string }>;
  removeEntity(id: string): void;

  onSymbolChanged(): ChartSubscription;
  onIntervalChanged(): ChartSubscription;
}

/** The pre-2026-09 editor API; kept as a fallback. */
export interface PineEditorTestApi {
  openEditor(): Promise<void>;
  openNewScript(): Promise<void>;
  setEditorText(code: string): Promise<void>;
  addScriptOnChart(): Promise<void>;
}

/** An open Pine Editor, one per placement. */
export interface PineEditorFacade {
  placement: 'dialog' | 'bottom' | 'detach';
  /** False for a saved script: editing it would save over the user's work. */
  isDraft(): boolean;
  isModified(): boolean;
  openNewScript(kind?: 'indicator' | 'strategy' | 'library'): Promise<void>;
  setScript(code: string): Promise<void>;
  getSource(): Promise<string>;
  addToChart(): Promise<void>;
}

export interface PineEditorApi {
  /**
   * Without a placement TradingView picks one, and may open a new tab.
   * `dialog` also needs `forceOpen` while the widget bar is collapsed.
   */
  open(options?: {
    placement?: 'dialog' | 'bottom' | 'detach';
    forceOpen?: boolean;
  }): Promise<void>;
  getDialogFacade(): PineEditorFacade | null;
  getBottomFacade(): PineEditorFacade | null;
}

export interface TradingViewApi {
  activeChart(): Chart;
  pineEditorApi?(): PineEditorApi;
  pineEditorTestApi?(): PineEditorTestApi;
}

/** One page in the right-hand widget bar. */
export interface WidgetBarPage {
  name: string;
  element(): HTMLElement | null;
  tab?: unknown;
}

export interface WidgetBarLayout {
  pages: WidgetBarPage[];
  activeIndex: number;
  activeName?: string;
  activePageIndex: WatchedValue<number>;
  isMinimized: WatchedValue<boolean>;
  setMinimizedState(minimized: boolean): void;
  switchPage(index: number): void;
  createPage(): WidgetBarPage;
  removePage(page: WidgetBarPage): void;
}

export interface WidgetBar {
  layout?: WidgetBarLayout;
}

declare global {
  interface Window {
    TradingViewApi?: TradingViewApi;
    widgetbar?: WidgetBar;
    is_authenticated?: boolean;
    user?: { id?: number };
    /** The driver's own test hook. */
    __tvAgent?: Record<string, unknown>;
  }
}
